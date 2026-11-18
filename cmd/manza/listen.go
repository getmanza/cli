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
	jsonLines bool
	http      *http.Client
}

func listen(f flags, config *runConfig, jsonLines bool) error {
	printSecret := f.truthy("print-secret")
	if !printSecret {
		if err := requireValue(f.value("forward-to"), "forward URL. Use --forward-to <url>"); err != nil {
			return err
		}
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

	for {
		l.s.recorder.streamed = false
		err := l.stream(ctx, session)
		if ctx.Err() != nil {
			stop() // a second ^C now kills the process
			l.close(session)
			return nil
		}
		if err == nil {
			return cliErrorf("%s", listenerClosed)
		}
		// An expired session answers the reconnect with not found. One that
		// never opened its stream is not renewed: that would loop.
		var apiErr *manza.Error
		if l.s.recorder.streamed && errors.As(err, &apiErr) && apiErr.Kind == manza.KindNotFound {
			if session, err = l.create(); err != nil {
				return err
			}
			fmt.Fprintln(os.Stderr, "Session renewed")
			continue
		}
		failure := l.s.handleError(err)
		l.close(session)
		return failure
	}
}

// stream forwards the session's events until the stream ends: nil when
// the listener closed or ctx is done, else the SDK's error.
func (l *listener) stream(ctx context.Context, session manza.WebhookListener) error {
	for event, err := range l.s.client.WebhookListeners.Stream(ctx, session, manza.WebhookListenerStreamOptions{}) {
		if err != nil {
			return err
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
		return // interrupted mid-POST: shutting down
	}
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
		fmt.Fprintf(os.Stderr, "%s  <-- [%d] POST %s (%d ms)\n", clock(), status, l.forwardTo, ms)
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
