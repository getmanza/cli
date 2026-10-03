package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	manza "github.com/getmanza/manza-go"
)

type runConfig struct {
	apiKey           string
	baseURL          string
	apiVersion       string
	requestTimeoutMs int
	output           string
	quiet            bool
	debug            bool
}

// errAPIPrinted means an API error was already printed; exit 1 silently.
var errAPIPrinted = errors.New("api error printed")

// recorder keeps the last raw response. The SDK's Response and Error don't
// carry headers (Content-Type, Manza-Version) or the body in key order,
// both of which the 1.x output depends on.
type recorder struct {
	status int
	header http.Header
	body   []byte
}

func (r *recorder) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		return nil, err
	}
	r.status, r.header, r.body = resp.StatusCode, resp.Header, body
	resp.Body = io.NopCloser(bytes.NewReader(body))
	return resp, nil
}

// parsedBody mirrors the 1.x SDK: no body unless the response is JSON;
// unparseable JSON stays a string.
func (r *recorder) parsedBody() any {
	if !strings.Contains(r.header.Get("Content-Type"), "json") || len(r.body) == 0 {
		return nil
	}
	value, err := parseJSON(string(r.body))
	if err != nil {
		return string(r.body)
	}
	return value
}

type sender struct {
	config   *runConfig
	client   *manza.Client
	recorder *recorder
}

func newSender(config *runConfig) (*sender, error) {
	// manza.New reads the legacy ZAZU_* variables itself and warns in its own
	// format. The CLI has already resolved (and warned about) them, so hide
	// them from the SDK.
	for _, name := range []string{"ZAZU_API_KEY", "ZAZU_BASE_URL", "ZAZU_API_VERSION"} {
		os.Unsetenv(name)
	}

	rec := &recorder{}
	client, err := manza.New(
		manza.WithAPIKey(config.apiKey),
		manza.WithBaseURL(config.baseURL),
		manza.WithAPIVersion(config.apiVersion),
		manza.WithHTTPClient(&http.Client{Transport: rec}),
	)
	if err != nil {
		var configErr *manza.ConfigurationError
		if errors.As(err, &configErr) {
			return nil, cliErrorf("%s", configErr.Message)
		}
		return nil, err
	}
	return &sender{config: config, client: client, recorder: rec}, nil
}

func send(config *runConfig, req *apiRequest) error {
	if config.apiKey == "" {
		return cliErrorf("Missing API key. Run `manza login`, set MANZA_API_KEY, or pass --api-key.")
	}

	s, err := newSender(config)
	if err != nil {
		return err
	}

	if req.paginate {
		return s.sendPaginated(req)
	}

	body, err := s.fetch(req, req.query)
	if err != nil {
		return s.handleError(err)
	}
	// The SDK list methods wrapped every response in a Page.
	if page, ok := body.(*object); req.sdkList && !hasDataArray(page, ok) {
		return errNoDataArray
	}
	printOutput(body, config)
	return nil
}

func (s *sender) sendPaginated(req *apiRequest) error {
	limitValue, _ := req.query.Get("limit")
	pageLimit, err := parseOptionalPositiveInteger(limitValue, "limit")
	if err != nil {
		return err
	}
	if pageLimit == 0 {
		pageLimit = req.pageLimit
	}
	if pageLimit == 0 {
		pageLimit = listPageSize
	}

	baseQuery := req.query.Clone()
	baseQuery.Set("limit", pageLimit)
	initialCursor, _ := baseQuery.Get("cursor")
	baseQuery.Delete("cursor")

	data := []any{}
	cursor := initialCursor
	var lastBody *object
	var lastCursor any
	truncated := false

	for {
		query := baseQuery.Clone()
		if truthy(cursor) {
			query.Set("cursor", jsString(cursor))
		}
		if req.maxItems > 0 {
			remaining := req.maxItems - len(data)
			query.Set("limit", min(pageLimit, max(remaining, 1), listPageSize))
		}

		raw, err := s.fetch(req, query)
		if err != nil {
			return s.handleError(err)
		}
		page, ok := raw.(*object)
		if !hasDataArray(page, ok) {
			return errNoDataArray
		}
		data0, _ := page.Get("data")
		items := data0.([]any)
		hasMoreValue, _ := page.Get("has_more")
		hasMore := truthy(hasMoreValue)
		nextCursor, _ := page.Get("next_cursor")
		lastBody, lastCursor = page, nextCursor

		for _, item := range items {
			if req.maxItems > 0 && len(data) >= req.maxItems {
				break
			}
			data = append(data, item)
		}
		if req.maxItems > 0 && len(data) >= req.maxItems {
			truncated = hasMore
			break
		}
		if !hasMore || !truthy(nextCursor) {
			break
		}
		cursor = nextCursor
	}

	out := lastBody.Clone()
	out.Set("data", data)
	out.Set("has_more", truncated)
	if truncated {
		out.Set("next_cursor", lastCursor)
	} else {
		out.Set("next_cursor", nil)
	}
	printOutput(out, s.config)
	return nil
}

var errNoDataArray = cliErrorf("Page response body has no `data` array — was this a list endpoint?")

func hasDataArray(page *object, ok bool) bool {
	if !ok {
		return false
	}
	data, _ := page.Get("data")
	_, isList := data.([]any)
	return isList
}

// fetch sends one request and returns the parsed response body.
func (s *sender) fetch(req *apiRequest, query *object) (any, error) {
	var body *object
	if req.body != nil {
		resolved, err := req.body()
		if err != nil {
			return nil, err
		}
		body = resolved
	}

	if s.config.debug {
		fmt.Fprintf(os.Stderr, "%s %s\n", req.method, debugURL(s.config.baseURL, req.path, query))
	}

	timeout := time.Duration(s.config.requestTimeoutMs) * time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	var err error
	if req.call != nil {
		_, err = req.call(ctx, s.client)
	} else {
		var payload any
		if body != nil && (body.Len() > 0 || req.alwaysBody) {
			payload = body
		}
		sent, queryErr := s.requestQuery(req, query)
		if queryErr != nil {
			return nil, queryErr
		}
		path := pathWithQuery(normalizePath(req.path), sent)
		_, err = s.client.Request(ctx, req.method, path, nil, payload)
	}

	if err != nil {
		var connErr *manza.ConnectionError
		if errors.As(err, &connErr) {
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return nil, cliErrorf("Request timed out after %dms", s.config.requestTimeoutMs)
			}
			return nil, cliErrorf("Connection failed: %s", connErr.Message)
		}
		return nil, err
	}
	return s.recorder.parsedBody(), nil
}

// requestQuery is the query actually sent. The SDK list methods sent limit
// (default 100) then cursor.
func (s *sender) requestQuery(req *apiRequest, query *object) (*object, error) {
	if !req.sdkList || query == nil {
		return query, nil
	}
	out := newObject()
	limit := listPageSize
	if value, ok := query.Get("limit"); ok && value != nil {
		limit, _ = parseOptionalPositiveInteger(value, "limit")
	}
	if limit > listPageSize {
		return nil, cliErrorf("limit cannot exceed %d (got %d)", listPageSize, limit)
	}
	out.Set("limit", limit)
	if cursor, ok := query.Get("cursor"); ok && cursor != nil {
		out.Set("cursor", cursor)
	}
	return out, nil
}

// pathWithQuery adds query to a path that may already carry one (a raw
// `manza request` path), the way 1.x did with new URL() + searchParams.set:
// the fragment is dropped, an existing query is percent-encoded as is, and
// once any parameter is set the whole query is reparsed, each parameter
// replaces a same-named one, and everything is reserialized.
func pathWithQuery(path string, query *object) string {
	path, _, _ = strings.Cut(path, "#")
	base, existing, hasQuery := strings.Cut(path, "?")
	if !hasQuery {
		return path + queryString(query)
	}

	params := newObject()
	if query != nil {
		for _, key := range query.keys {
			if value := query.vals[key]; value != nil {
				params.Set(key, jsString(value))
			}
		}
	}
	if params.Len() == 0 {
		return base + "?" + encodeQuery(existing)
	}

	pairs := parseSearchParams(existing)
	for _, key := range params.keys {
		value := params.vals[key].(string)
		replaced := false
		kept := pairs[:0]
		for _, pair := range pairs {
			if pair[0] != key {
				kept = append(kept, pair)
			} else if !replaced {
				kept = append(kept, [2]string{key, value})
				replaced = true
			}
		}
		pairs = kept
		if !replaced {
			pairs = append(pairs, [2]string{key, value})
		}
	}

	parts := make([]string, len(pairs))
	for i, pair := range pairs {
		parts[i] = formEncode(pair[0]) + "=" + formEncode(pair[1])
	}
	return base + "?" + strings.Join(parts, "&")
}

// parseSearchParams mirrors the URLSearchParams constructor.
func parseSearchParams(query string) [][2]string {
	var pairs [][2]string
	for _, part := range strings.Split(query, "&") {
		if part == "" {
			continue
		}
		key, value, _ := strings.Cut(part, "=")
		pairs = append(pairs, [2]string{formDecode(key), formDecode(value)})
	}
	return pairs
}

// formDecode turns + into a space and decodes %XX, leaving bad escapes as is.
func formDecode(s string) string {
	s = strings.ReplaceAll(s, "+", " ")
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) && isHex(s[i+1]) && isHex(s[i+2]) {
			n, _ := strconv.ParseUint(s[i+1:i+3], 16, 8)
			b.WriteByte(byte(n))
			i += 2
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func isHex(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

// encodeQuery applies the WHATWG query percent-encode set (special schemes).
func encodeQuery(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c <= 0x20 || c >= 0x7f || strings.IndexByte("\"#<>'", c) >= 0 {
			b.WriteString("%" + strings.ToUpper(hexByte(c)))
		} else {
			b.WriteByte(c)
		}
	}
	return b.String()
}

func (s *sender) handleError(err error) error {
	var apiErr *manza.Error
	if errors.As(err, &apiErr) {
		printError(s.recorder, s.config.output)
		return errAPIPrinted
	}
	var argErr *manza.ArgumentError
	if errors.As(err, &argErr) {
		return cliErrorf("%s", argErr.Message)
	}
	return err
}

func normalizePath(value string) string {
	if strings.HasPrefix(value, "/api/") || value == "/api" {
		return value
	}
	if !strings.HasPrefix(value, "/") {
		value = "/" + value
	}
	return "/api" + value
}

// queryString serializes like URLSearchParams, skipping null values.
func queryString(query *object) string {
	if query == nil {
		return ""
	}
	var parts []string
	for _, key := range query.keys {
		value := query.vals[key]
		if value == nil {
			continue
		}
		parts = append(parts, formEncode(key)+"="+formEncode(jsString(value)))
	}
	if len(parts) == 0 {
		return ""
	}
	return "?" + strings.Join(parts, "&")
}

func debugURL(baseURL, path string, query *object) string {
	visible := newObject()
	if query != nil {
		for _, key := range query.keys {
			if value := query.vals[key]; value != nil && value != "" {
				visible.Set(key, value)
			}
		}
	}
	target := pathWithQuery(normalizePath(path), visible)
	base, err := url.Parse(baseURL + "/")
	if err != nil {
		return baseURL + target
	}
	ref, err := url.Parse(target)
	if err != nil {
		return baseURL + target
	}
	return base.ResolveReference(ref).String()
}

func printOutput(value any, config *runConfig) {
	if config.quiet || value == nil || value == "" {
		return
	}
	if text, ok := value.(string); ok && config.output == "raw" {
		fmt.Println(text)
		return
	}
	fmt.Println(stringify(value, config.output == "pretty"))
}

var defaultErrorMessages = map[int]string{
	400: "Bad request",
	401: "Authentication failed",
	403: "Forbidden",
	404: "Not found",
	409: "Conflict",
	422: "Validation failed",
	429: "Rate limited",
}

func printError(rec *recorder, format string) {
	body := rec.parsedBody()
	payload := newObject()
	if obj, ok := body.(*object); ok {
		if inner, ok := obj.Get("error"); ok {
			if innerObj, ok := inner.(*object); ok {
				payload = innerObj
			}
		}
	}

	message, ok := defaultErrorMessages[rec.status]
	if !ok {
		message = fmt.Sprintf("Unexpected status %d", rec.status)
		if rec.status >= 500 && rec.status < 600 {
			message = fmt.Sprintf("Server error (%d)", rec.status)
		}
	}
	if value, ok := payload.Get("message"); ok && value != nil {
		message = jsString(value)
	}

	if format == "raw" {
		switch v := body.(type) {
		case string:
			fmt.Fprintln(os.Stderr, v)
		case nil:
			fmt.Fprintln(os.Stderr, message)
		default:
			fmt.Fprintln(os.Stderr, stringify(v, false))
		}
		return
	}

	var out *object
	if obj, ok := body.(*object); ok {
		out = obj.Clone()
	} else {
		errorType, _ := payload.Get("type")
		param, _ := payload.Get("param")
		inner := newObject()
		inner.Set("message", message)
		inner.Set("type", errorType)
		inner.Set("param", param)
		out = newObject()
		out.Set("error", inner)
	}
	out.Set("status", rec.status)
	if rec.status == 409 {
		if paymentID, _ := payload.Get("payment_id"); truthy(paymentID) {
			out.Set("payment_id", paymentID)
		}
	}
	if requestID := rec.header.Get("X-Request-Id"); requestID != "" {
		out.Set("request_id", requestID)
	}
	version := rec.header.Get("Manza-Version")
	if version == "" {
		version = rec.header.Get("Zazu-Version")
	}
	if version != "" {
		out.Set("manza_version", version)
	}
	fmt.Fprintln(os.Stderr, stringify(out, format == "pretty"))
}
