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
	"os/signal"
	"regexp"
	"strings"
	"syscall"
	"time"

	manza "github.com/getmanza/manza-go/v2"
)

// forwardTimeout matches the platform's webhook delivery timeout.
const forwardTimeout = 10 * time.Second

const (
	authorizerWarning = "Challenges also go to your registered authorizer; the first answer wins. Five bad signatures suspend the authorizer for everyone using it."
	authorizerHint    = "--authorizer needs an API key with the transfers:authorize scope and an IP allowlist."
	listenerClosed    = "Listener closed by the server: the API key was revoked or the session was closed elsewhere."
)

// listener forwards a listen session's webhooks (and, with --authorizer,
// its transfer-authorization challenges) to a local server, signing each
// at forward time with the session's listen secret.
//
// Forwarding is the one place the CLI uses net/http directly: the local
// server is not the Manza API. Every API call still goes through the SDK.
type listener struct {
	s         *sender
	params    manza.WebhookListenerParams
	forwardTo string
	shown     string // forwardTo as logged: its password masked
	jsonLines bool
	http      *http.Client
	forwarded int // events forwarded so far
	// deadline is when the current session expires on this machine's
	// clock; zero when unknown.
	deadline time.Time
}

// minSessionLifetime is the shortest session the CLI times out by itself:
// a shorter (or past) expires_at is ignored rather than renewed in a loop.
const minSessionLifetime = time.Second

// notFoundWindow: a renewed session found missing again within it, before
// it forwarded anything, ends the command instead of renewing again.
const notFoundWindow = 10 * time.Minute

func listen(args []string, f flags, config *runConfig, jsonLines bool) error {
	// A boolean flag swallows no value: `--authorizer false` would leave
	// "false" behind as an argument, `--authorizer=false` would still mean true.
	for _, name := range []string{"authorizer", "print-secret"} {
		for _, value := range f[name] {
			if value != true {
				return cliErrorf("--authorizer and --print-secret take no value: leave the flag out to turn it off.")
			}
		}
	}
	if len(args) > 0 {
		return cliErrorf("Unexpected argument \"%s\". Usage: manza listen --forward-to <url> [--events type,type] [--authorizer]", args[0])
	}
	printSecret := f.truthy("print-secret")
	var shown string
	if !printSecret {
		if err := requireValue(f.value("forward-to"), "forward URL. Use --forward-to <url>"); err != nil {
			return err
		}
		if len(f["forward-to"]) > 1 {
			return cliErrorf("Pass --forward-to once: listen forwards to one URL.")
		}
		target, err := url.Parse(f.str("forward-to"))
		if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Host == "" {
			return cliErrorf("Invalid --forward-to \"%s\". Use an http:// or https:// URL, such as http://localhost:4242/webhooks.", f.str("forward-to"))
		}
		shown = target.Redacted() // a password in the URL never reaches the log
	}
	if config.apiKey == "" {
		return cliErrorf("Missing API key. Run `manza login`, set MANZA_API_KEY, or pass --api-key.")
	}
	s, err := newSender(config)
	if err != nil {
		return err
	}

	l := &listener{
		s:         s,
		params:    manza.WebhookListenerParams{Events: listenEvents(f), Authorizer: f.truthy("authorizer")},
		forwardTo: f.str("forward-to"),
		shown:     shown,
		jsonLines: jsonLines,
		http: &http.Client{
			Timeout:       forwardTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}

	session, err := l.create()
	if err != nil {
		return err
	}
	if printSecret {
		fmt.Println(session.SigningSecret)
		l.close(session)
		return nil
	}
	return l.run(session)
}

// listenEvents is every --events value split on commas.
func listenEvents(f flags) []string {
	var events []string
	for _, value := range f["events"] {
		for _, event := range strings.Split(jsString(value), ",") {
			if event = strings.TrimSpace(event); event != "" {
				events = append(events, event)
			}
		}
	}
	return events
}

// explicitJSON reports whether JSON output was asked for, not defaulted:
// manza listen prints JSON lines only then.
func explicitJSON(globals flags) bool {
	return outputFormat(globals) == "json" && (globals.has("json") || globals.has("format") || globals.has("output"))
}

func (l *listener) run(session manza.WebhookListener) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	fmt.Fprintf(os.Stderr, "Ready! Listening for %s. Your listen signing secret is %s (^C to quit)\n", l.subject(), session.SigningSecret)
	if l.params.Authorizer {
		fmt.Fprintln(os.Stderr, authorizerWarning)
	}

	renewedAt := -1 // l.forwarded when a not-found last renewed the session
	var renewedTime time.Time
	for {
		l.s.recorder.streamed = false
		streamCtx, cancel := l.untilExpiry(ctx)
		err := l.stream(streamCtx, ctx, session)
		expired := streamCtx.Err() != nil
		cancel()
		if ctx.Err() != nil {
			stop() // a second ^C now kills the process
			l.close(session)
			return nil
		}
		// The server stops sending to an expired session but may keep its
		// connection open: renew at expires_at rather than go quiet.
		if expired {
			if session, err = l.renew(); err != nil {
				return err
			}
			continue
		}
		if err == nil {
			return cliErrorf("%s", listenerClosed)
		}
		// An expired session answers the reconnect with not found. One that
		// never opened its stream is not renewed, and neither is a renewed
		// one found missing again before it forwarded anything: either
		// would loop creating sessions.
		var apiErr *manza.Error
		notFound := errors.As(err, &apiErr) && apiErr.Kind == manza.KindNotFound
		looping := renewedAt == l.forwarded && time.Since(renewedTime) < notFoundWindow
		if notFound && l.s.recorder.streamed && !looping {
			renewedAt, renewedTime = l.forwarded, time.Now()
			if session, err = l.renew(); err != nil {
				return err
			}
			continue
		}
		var connErr *manza.ConnectionError
		if errors.As(err, &connErr) {
			// Its message holds the stream URL, whose query is a token.
			err = cliErrorf("Connection failed: %s", streamQuery.ReplaceAllString(connErr.Message, "?…"))
		}
		failure := l.s.handleError(err)
		if !notFound {
			l.close(session)
		}
		return failure
	}
}

var streamQuery = regexp.MustCompile(`\?[^"\s]*`)

// untilExpiry ends the stream when the session expires, if that is known.
func (l *listener) untilExpiry(ctx context.Context) (context.Context, context.CancelFunc) {
	if l.deadline.IsZero() {
		return context.WithCancel(ctx)
	}
	return context.WithDeadline(ctx, l.deadline)
}

// sessionDeadline is expires_at on this machine's clock: the session's
// lifetime is measured against the server's Date header, so a skewed local
// clock neither renews early in a loop nor late. Zero when expires_at does
// not parse or leaves under minSessionLifetime.
func sessionDeadline(expiresAt, date string, now time.Time) time.Time {
	expires, err := time.Parse(time.RFC3339, expiresAt)
	if err != nil {
		return time.Time{}
	}
	serverNow := now
	if parsed, err := http.ParseTime(date); err == nil {
		serverNow = parsed
	}
	lifetime := expires.Sub(serverNow)
	if lifetime < minSessionLifetime {
		return time.Time{}
	}
	return now.Add(lifetime)
}

func (l *listener) renew() (manza.WebhookListener, error) {
	session, err := l.create()
	if err == nil {
		fmt.Fprintln(os.Stderr, "Session renewed")
	}
	return session, err
}

// stream forwards the session's events until the stream ends: nil when
// the listener closed or streamCtx is done, else the SDK's error. Each
// POST runs under ctx, so a session reaching expires_at mid-POST still
// finishes it; frames still buffered at ^C are not forwarded.
func (l *listener) stream(streamCtx, ctx context.Context, session manza.WebhookListener) error {
	for event, err := range l.s.client.WebhookListeners.Stream(streamCtx, session, manza.WebhookListenerStreamOptions{}) {
		if err != nil {
			return err
		}
		if ctx.Err() != nil {
			return nil
		}
		l.forward(ctx, session.SigningSecret, event)
	}
	return nil
}

func (l *listener) subject() string {
	subject := "all events"
	if len(l.params.Events) > 0 {
		subject = strings.Join(l.params.Events, ", ")
	}
	if l.params.Authorizer {
		subject += " and transfer challenges"
	}
	return subject
}

// forward POSTs one event and reports it. A failed POST is reported and
// never retried: a retry would hide a broken local handler.
func (l *listener) forward(ctx context.Context, secret string, event manza.ListenerEvent) {
	fmt.Fprintf(os.Stderr, "%s  --> %s [%s]\n", clock(), event.EventType, event.EventID)
	started := time.Now()
	status, err := l.post(ctx, secret, event)
	if ctx.Err() != nil {
		fmt.Fprintf(os.Stderr, "%s  <-- [ERR] interrupted\n", clock())
		return
	}
	l.forwarded++
	ms := int(time.Since(started).Milliseconds())

	line := newObject()
	line.Set("event_id", event.EventID)
	line.Set("event_type", event.EventType)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s  <-- [ERR] %s\n", clock(), err)
		line.Set("status", nil)
		line.Set("duration_ms", ms)
		line.Set("error", err.Error())
	} else {
		fmt.Fprintf(os.Stderr, "%s  <-- [%d] POST %s (%d ms)\n", clock(), status, l.shown, ms)
		line.Set("status", status)
		line.Set("duration_ms", ms)
	}
	if l.jsonLines {
		printOutput(line, l.s.config)
	}
}

// post sends the body exactly as received, never re-serialized: the
// signature covers these bytes.
func (l *listener) post(ctx context.Context, secret string, event manza.ListenerEvent) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, l.forwardTo, bytes.NewReader(event.Body))
	if err != nil {
		return 0, err
	}
	req.Header = manza.WebhookHeaders(secret, event.EventType, event.EventID, event.ID, event.Body, time.Now())
	req.Header.Set("Content-Type", "application/json")

	resp, err := l.http.Do(req)
	if err != nil {
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			return 0, urlErr.Err // the URL is already on the line above
		}
		return 0, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, nil
}

func (l *listener) create() (manza.WebhookListener, error) {
	var session manza.WebhookListener
	ctx, cancel := l.requestContext()
	defer cancel()

	resp, err := l.s.client.WebhookListeners.Create(ctx, l.params)
	if err != nil {
		var apiErr *manza.Error
		if l.params.Authorizer && errors.As(err, &apiErr) && apiErr.Kind == manza.KindForbidden {
			printError(l.s.recorder, apiErr, l.s.config.output)
			return session, cliErrorf("%s", authorizerHint)
		}
		return session, l.s.handleError(l.s.connectionError(ctx, err))
	}
	if err := resp.Decode(&session); err != nil {
		return session, cliErrorf("Unexpected webhook listener response: %s", err)
	}
	l.deadline = sessionDeadline(session.ExpiresAt, l.s.recorder.header.Get("Date"), time.Now())
	return session, nil
}

// close deletes the session, best effort: an unclosed one expires anyway.
func (l *listener) close(session manza.WebhookListener) {
	ctx, cancel := l.requestContext()
	defer cancel()
	if _, err := l.s.client.WebhookListeners.Delete(ctx, session.ID); err != nil {
		fmt.Fprintf(os.Stderr, "Could not close listen session %s: %s\n", session.ID, err)
	}
}

func (l *listener) requestContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), time.Duration(l.s.config.requestTimeoutMs)*time.Millisecond)
}

func clock() string { return time.Now().Format("2006-01-02 15:04:05") }
