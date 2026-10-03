package main

import (
	"context"
	"strings"

	manza "github.com/getmanza/manza-go"
)

const listPageSize = 100

// apiRequest is one CLI command resolved to an API call. method and path
// are always set (--debug prints them); call, when set, sends it through a
// typed SDK method instead of Client.Request.
type apiRequest struct {
	method string
	path   string
	query  *object
	// body is resolved at send time, after the API key check, matching the
	// order errors surfaced in 1.x.
	body func() (*object, error)
	// alwaysBody sends the body even when empty ("{}"), as the typed SDK
	// create methods did in 1.x.
	alwaysBody bool
	call       func(ctx context.Context, client *manza.Client) (*manza.Response, error)

	paginate  bool
	maxItems  int // 0 = no cap
	pageLimit int // 0 = not given
	// sdkList builds the query like the SDK list methods: limit (default
	// 100, at most 100) then cursor.
	sdkList bool
}

func buildRequest(positionals []string, f flags) (*apiRequest, error) {
	resource, command, arg := at(positionals, 0), at(positionals, 1), at(positionals, 2)

	switch resource {
	case "status":
		return &apiRequest{method: "GET", path: "/api/entity"}, nil
	case "entity":
		if command != "get" {
			return nil, cliErrorf("Usage: manza entity get")
		}
		return &apiRequest{method: "GET", path: "/api/entity"}, nil
	case "accounts":
		return accountRequest(positionals[1:], f)
	case "transactions":
		return transactionRequest(command, arg, f)
	case "customers":
		return customerRequest(command, arg, f)
	case "invoices":
		return invoiceRequest(command, arg, f)
	case "payment-links", "payment_links":
		return paymentLinkRequest(command, arg, f)
	case "transfers", "transfer-drafts", "transfer_drafts":
		return transferDraftRequest(command, arg, f)
	case "beneficiaries":
		return beneficiaryRequest(positionals[1:], f)
	case "payee-trust-requests", "payee_trust_requests":
		return payeeTrustRequestRequest(command, arg, f)
	case "webhook-endpoints", "webhook_endpoints":
		return webhookEndpointRequest(command, arg, f)
	case "checkout-sessions", "checkout_sessions":
		return checkoutSessionRequest(command, arg, f)
	case "request":
		return rawRequest(positionals[1:], f)
	default:
		return nil, cliErrorf("Unknown command \"%s\". Run manza --help.", resource)
	}
}

func accountRequest(args []string, f flags) (*apiRequest, error) {
	command, id, transactionID := at(args, 0), at(args, 1), at(args, 2)

	switch command {
	case "list":
		return listRequest("/api/accounts", pick(f, "status", "currency-code", "cursor", "limit"), f)
	case "get":
		if err := requireString(id, "account id"); err != nil {
			return nil, err
		}
		return get("/api/accounts/" + encodeURIComponent(id)), nil
	case "transactions":
		if err := requireString(id, "account id"); err != nil {
			return nil, err
		}
		return listRequest("/api/accounts/"+encodeURIComponent(id)+"/transactions",
			pick(f, "operation", "posted-after", "posted-before", "cursor", "limit"), f)
	case "transaction":
		if err := requireString(id, "account id"); err != nil {
			return nil, err
		}
		if err := requireString(transactionID, "transaction id"); err != nil {
			return nil, err
		}
		return get("/api/accounts/" + encodeURIComponent(id) + "/transactions/" + encodeURIComponent(transactionID)), nil
	default:
		return nil, cliErrorf("Usage: manza accounts list|get|transactions|transaction")
	}
}

func transactionRequest(command, id string, f flags) (*apiRequest, error) {
	if err := requireValue(f.value("account-id"), "account id. Use --account-id <id>"); err != nil {
		return nil, err
	}
	accountPath := "/api/accounts/" + encodeURIComponent(f.str("account-id")) + "/transactions"

	switch command {
	case "list":
		return listRequest(accountPath, pick(f, "operation", "posted-after", "posted-before", "cursor", "limit"), f)
	case "get":
		if err := requireString(id, "transaction id"); err != nil {
			return nil, err
		}
		return get(accountPath + "/" + encodeURIComponent(id)), nil
	default:
		return nil, cliErrorf("Usage: manza transactions list|get --account-id <account-id>")
	}
}

func customerRequest(command, id string, f flags) (*apiRequest, error) {
	switch command {
	case "list":
		return listRequest("/api/customers", pick(f, "q", "cursor", "limit"), f)
	case "get", "delete":
		if err := requireString(id, "customer id"); err != nil {
			return nil, err
		}
		return &apiRequest{method: methodFor(command), path: "/api/customers/" + encodeURIComponent(id)}, nil
	case "create", "update":
		path := "/api/customers"
		method := "POST"
		if command == "update" {
			if err := requireString(id, "customer id"); err != nil {
				return nil, err
			}
			path += "/" + encodeURIComponent(id)
			method = "PATCH"
		}
		body, err := customerBody(f)
		if err != nil {
			return nil, err
		}
		return &apiRequest{method: method, path: path, body: bodyFromFlags(f, body)}, nil
	default:
		return nil, cliErrorf("Usage: manza customers list|get|create|update|delete")
	}
}

func invoiceRequest(command, id string, f flags) (*apiRequest, error) {
	actions := map[string]string{
		"send": "send", "mark-as-paid": "mark_as_paid", "mark_as_paid": "mark_as_paid",
		"cancel": "cancel", "credit-note": "credit_note", "credit_note": "credit_note",
	}

	switch command {
	case "list":
		return listRequest("/api/invoices", pick(f, "status", "customer-id", "cursor", "limit"), f)
	case "create":
		body, err := invoiceBody(f)
		if err != nil {
			return nil, err
		}
		return &apiRequest{method: "POST", path: "/api/invoices", body: bodyFromFlags(f, body)}, nil
	}

	if _, ok := actions[command]; !ok && !oneOf(command, "get", "update", "delete", "payment-link", "payment_link") {
		return nil, cliErrorf("Usage: manza invoices list|get|create|update|send|mark-as-paid|cancel|credit-note|delete|payment-link")
	}
	if err := requireString(id, "invoice id"); err != nil {
		return nil, err
	}
	path := "/api/invoices/" + encodeURIComponent(id)

	switch command {
	case "get", "delete":
		return &apiRequest{method: methodFor(command), path: path}, nil
	case "update":
		body, err := invoiceBody(f)
		if err != nil {
			return nil, err
		}
		return &apiRequest{method: "PATCH", path: path, body: bodyFromFlags(f, body)}, nil
	case "payment-link", "payment_link":
		return &apiRequest{method: "POST", path: path + "/payment_link", body: bodyFromFlags(f, pick(f, "account-id"))}, nil
	default:
		return &apiRequest{method: "POST", path: path + "/" + actions[command]}, nil
	}
}

func paymentLinkRequest(command, id string, f flags) (*apiRequest, error) {
	switch command {
	case "list":
		return listRequest("/api/payment_links", pick(f, "status", "link-type", "cursor", "limit"), f)
	case "get":
		if err := requireString(id, "payment link id"); err != nil {
			return nil, err
		}
		return get("/api/payment_links/" + encodeURIComponent(id)), nil
	case "create":
		body := pick(f, "account-id", "amount", "title", "description", "payment-reference",
			"expires-at", "link-type", "redirect-url", "max-payments")
		return &apiRequest{method: "POST", path: "/api/payment_links", body: bodyFromFlags(f, body)}, nil
	case "cancel":
		if err := requireString(id, "payment link id"); err != nil {
			return nil, err
		}
		return &apiRequest{method: "POST", path: "/api/payment_links/" + encodeURIComponent(id) + "/cancel"}, nil
	default:
		return nil, cliErrorf("Usage: manza payment-links list|get|create|cancel")
	}
}

func transferDraftRequest(command, id string, f flags) (*apiRequest, error) {
	switch command {
	case "create":
		body := pick(f, "account-id", "beneficiary-id", "external-account-id", "destination-account-id",
			"amount", "currency-code", "payment-reference", "internal-notes", "client-reference")
		return &apiRequest{method: "POST", path: "/api/transfer_drafts", body: bodyFromFlags(f, body), alwaysBody: true}, nil
	case "get":
		if err := requireString(id, "transfer draft id"); err != nil {
			return nil, err
		}
		return get("/api/transfer_drafts/" + encodeURIComponent(id)), nil
	case "authorize":
		if err := requireString(id, "transfer draft id"); err != nil {
			return nil, err
		}
		if err := requireValue(f.value("authorization-id"), "authorization id. Use --authorization-id <id>"); err != nil {
			return nil, err
		}
		if err := requireValue(f.value("signature"), "signature. Use --signature <hex>"); err != nil {
			return nil, err
		}
		signature := f.str("signature")
		if strings.TrimSpace(signature) == "" {
			return nil, cliErrorf("signature cannot be blank")
		}
		body := newObject()
		body.Set("authorization_id", f.str("authorization-id"))
		body.Set("signature", signature)
		return transferDraftAction(id, "authorize", body), nil
	case "decline":
		if err := requireString(id, "transfer draft id"); err != nil {
			return nil, err
		}
		if err := requireValue(f.value("authorization-id"), "authorization id. Use --authorization-id <id>"); err != nil {
			return nil, err
		}
		body := newObject()
		body.Set("authorization_id", f.str("authorization-id"))
		if f.has("reason") {
			body.Set("reason", f.str("reason"))
		}
		return transferDraftAction(id, "decline", body), nil
	default:
		return nil, cliErrorf("Usage: manza transfers create|get|authorize|decline|sign")
	}
}

// transferDraftAction goes through Client.Request rather than the typed
// Authorize/Decline: manza-go v1.0.0 escapes the "api/transfer_drafts"
// base of those paths into "api%2Ftransfer_drafts".
func transferDraftAction(id, action string, body *object) *apiRequest {
	return &apiRequest{
		method:     "POST",
		path:       "/api/transfer_drafts/" + encodeURIComponent(id) + "/" + action,
		body:       func() (*object, error) { return body, nil },
		alwaysBody: true,
	}
}

func beneficiaryRequest(args []string, f flags) (*apiRequest, error) {
	command, id := at(args, 0), at(args, 1)

	switch command {
	case "list":
		req, err := listRequest("/api/beneficiaries", pick(f, "cursor", "limit"), f)
		if err == nil {
			req.sdkList = true
		}
		return req, err
	case "get":
		if err := requireString(id, "beneficiary id"); err != nil {
			return nil, err
		}
		return get("/api/beneficiaries/" + encodeURIComponent(id)), nil
	case "create":
		body := pick(f, "beneficiary-type", "person-name", "company-name", "email", "phone-number")
		return &apiRequest{method: "POST", path: "/api/beneficiaries", body: bodyFromFlags(f, body), alwaysBody: true}, nil
	case "accounts", "external-accounts", "external_accounts":
		return beneficiaryAccountRequest(args[1:], f)
	default:
		return nil, cliErrorf("Usage: manza beneficiaries list|get|create|accounts")
	}
}

func beneficiaryAccountRequest(args []string, f flags) (*apiRequest, error) {
	command, beneficiaryID, id := at(args, 0), at(args, 1), at(args, 2)
	basePath := "/api/beneficiaries/" + encodeURIComponent(beneficiaryID) + "/external_accounts"

	if !oneOf(command, "list", "get", "create") {
		return nil, cliErrorf("Usage: manza beneficiaries accounts list|get|create <beneficiary-id>")
	}
	if err := requireString(beneficiaryID, "beneficiary id"); err != nil {
		return nil, err
	}

	switch command {
	case "list":
		req, err := listRequest(basePath, pick(f, "cursor", "limit"), f)
		if err == nil {
			req.sdkList = true
		}
		return req, err
	case "get":
		if err := requireString(id, "external account id"); err != nil {
			return nil, err
		}
		return get(basePath + "/" + encodeURIComponent(id)), nil
	default:
		body := pick(f, "account-number", "name", "country-code", "currency-code", "account-type", "bank-identifier")
		return &apiRequest{method: "POST", path: basePath, body: bodyFromFlags(f, body), alwaysBody: true}, nil
	}
}

func payeeTrustRequestRequest(command, id string, f flags) (*apiRequest, error) {
	switch command {
	case "create":
		var ids []string
		for _, v := range f["external-account-id"] {
			ids = append(ids, jsString(v))
		}
		if len(ids) == 0 || ids[0] == "" {
			return nil, cliErrorf("Missing external account id. Use --external-account-id <id>.")
		}
		return &apiRequest{
			method: "POST",
			path:   "/api/payee_trust_requests",
			call: func(ctx context.Context, c *manza.Client) (*manza.Response, error) {
				return c.PayeeTrustRequests.Create(ctx, ids)
			},
		}, nil
	case "get":
		if err := requireString(id, "payee trust request id"); err != nil {
			return nil, err
		}
		return get("/api/payee_trust_requests/" + encodeURIComponent(id)), nil
	default:
		return nil, cliErrorf("Usage: manza payee-trust-requests create|get")
	}
}

func webhookEndpointRequest(command, id string, f flags) (*apiRequest, error) {
	actions := map[string]string{
		"test": "test", "enable": "enable", "disable": "disable",
		"regenerate-secret": "regenerate_secret", "regenerate_secret": "regenerate_secret",
		"rotate-secret": "regenerate_secret", "rotate_secret": "regenerate_secret",
	}

	switch command {
	case "list":
		return listRequest("/api/webhook_endpoints", pick(f, "cursor", "limit"), f)
	case "create":
		body, err := webhookEndpointBody(f)
		if err != nil {
			return nil, err
		}
		return &apiRequest{method: "POST", path: "/api/webhook_endpoints", body: bodyFromFlags(f, body)}, nil
	}

	if _, ok := actions[command]; !ok && !oneOf(command, "get", "update", "delete") {
		return nil, cliErrorf("Usage: manza webhook-endpoints list|get|create|update|delete|test|regenerate-secret|enable|disable")
	}
	if err := requireString(id, "webhook endpoint id"); err != nil {
		return nil, err
	}
	path := "/api/webhook_endpoints/" + encodeURIComponent(id)

	switch command {
	case "get", "delete":
		return &apiRequest{method: methodFor(command), path: path}, nil
	case "update":
		body, err := webhookEndpointBody(f)
		if err != nil {
			return nil, err
		}
		return &apiRequest{method: "PATCH", path: path, body: bodyFromFlags(f, body)}, nil
	default:
		return &apiRequest{method: "POST", path: path + "/" + actions[command]}, nil
	}
}

func checkoutSessionRequest(command, id string, f flags) (*apiRequest, error) {
	switch command {
	case "get":
		if err := requireString(id, "checkout session id"); err != nil {
			return nil, err
		}
		return get("/api/checkout_sessions/" + encodeURIComponent(id)), nil
	case "create":
		body, err := checkoutSessionBody(f)
		if err != nil {
			return nil, err
		}
		return &apiRequest{method: "POST", path: "/api/checkout_sessions", body: bodyFromFlags(f, body)}, nil
	default:
		return nil, cliErrorf("Usage: manza checkout-sessions create|get")
	}
}

func listRequest(path string, query *object, f flags) (*apiRequest, error) {
	maxItems, err := parseOptionalPositiveInteger(f.value("max-items"), "max-items")
	if err != nil {
		return nil, err
	}
	all := f.truthy("all") || maxItems > 0
	limitValue, hasLimit := query.Get("limit")
	if hasLimit && limitValue == nil {
		// --limit null coerces to null; 1.x rejected it rather than omit it.
		return nil, cliErrorf("Invalid --limit \"null\". Use a positive integer.")
	}
	pageLimit, err := parseOptionalPositiveInteger(limitValue, "limit")
	if err != nil {
		return nil, err
	}

	nextQuery := query.Clone()
	if all && pageLimit == 0 {
		limit := listPageSize
		if maxItems > 0 {
			limit = min(maxItems, listPageSize)
		}
		nextQuery.Set("limit", limit)
	}

	return &apiRequest{
		method:    "GET",
		path:      path,
		query:     nextQuery,
		paginate:  all,
		maxItems:  maxItems,
		pageLimit: pageLimit,
	}, nil
}

func rawRequest(args []string, f flags) (*apiRequest, error) {
	method, path := at(args, 0), at(args, 1)
	if err := requireString(method, "HTTP method"); err != nil {
		return nil, err
	}
	if err := requireString(path, "request path"); err != nil {
		return nil, err
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}

	query := newObject()
	for _, item := range f["query"] {
		text := jsString(item)
		key, value, ok := strings.Cut(text, "=")
		if !ok {
			return nil, cliErrorf("Invalid --query \"%s\". Use key=value.", text)
		}
		query.Set(key, value)
	}

	return &apiRequest{
		method: strings.ToUpper(method),
		path:   path,
		query:  query,
		body:   bodyFromFlags(f, newObject()),
	}, nil
}

func get(path string) *apiRequest { return &apiRequest{method: "GET", path: path} }

func methodFor(command string) string {
	if command == "delete" {
		return "DELETE"
	}
	return "GET"
}

func at(values []string, i int) string {
	if i < len(values) {
		return values[i]
	}
	return ""
}

func oneOf(value string, options ...string) bool {
	for _, option := range options {
		if value == option {
			return true
		}
	}
	return false
}

// encodeURIComponent mirrors the JavaScript function of the same name.
func encodeURIComponent(s string) string {
	const unreserved = "-_.!~*'()"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if isAlnum(c) || strings.IndexByte(unreserved, c) >= 0 {
			b.WriteByte(c)
		} else {
			b.WriteString("%" + strings.ToUpper(hexByte(c)))
		}
	}
	return b.String()
}

// formEncode mirrors URLSearchParams serialization of one key or value.
func formEncode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case isAlnum(c) || c == '*' || c == '-' || c == '.' || c == '_':
			b.WriteByte(c)
		case c == ' ':
			b.WriteByte('+')
		default:
			b.WriteString("%" + strings.ToUpper(hexByte(c)))
		}
	}
	return b.String()
}

func isAlnum(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

func hexByte(c byte) string {
	const hex = "0123456789abcdef"
	return string([]byte{hex[c>>4], hex[c&0xf]})
}
