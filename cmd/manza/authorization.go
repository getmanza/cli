package main

import (
	"math/big"
	"strings"
	"time"
)

// refusalReasons says, in the words of the transfer-authorization docs'
// troubleshooting table, why a payment went to the in-app approvers. The
// README's "Debugging transfer authorization" table carries the same rows
// (authorization_test.go keeps them in step).
var refusalReasons = map[string]string{
	"untrusted_payee":      "The payee's bank details are not trusted: never trusted with Approve transfers to new payees off, or a member revoked their trust, or they were edited after trusting",
	"unrestricted_api_key": "The payee is not trusted yet and the API key that created the transfer has no IP allowlist (or one whose networks together allow every address), or was revoked since",
	"over_new_payee_limit": "The payee is not trusted yet and the amount is above the limit per transfer to a new payee",
	"over_transfer_limit":  "The amount is above the limit per transfer",
	"over_daily_limit":     "This amount plus the last 24 hours' authorized total is above the limit per 24 hours",
	"currency_mismatch":    "The source account's currency is not the enrolled currency",
	"suspended":            "Transfer authorization is suspended, or its endpoint is disabled",
	"secret_expired":       "The signing secret passed secret_expires_at",
	"signature_failed":     "Five invalid signatures on one challenge",
	"stale":                "The transfer, the payee's bank details or the enrolled endpoint changed after the challenge was sent",
	"expired":              "Nobody answered the challenge within one hour",
}

// suspensionReasons explains a suspended authorizer's suspension_reason.
var suspensionReasons = map[string]string{
	"member":             "an approver suspended it in the app",
	"signature_failures": "five invalid signatures in a row",
	"secret_expired":     "the signing secret expired",
	"endpoint_disabled":  "its webhook endpoint is disabled or deleted",
}

const secretExpiryWarning = 7 * 24 * time.Hour

// approvalNote is the "Approval" line for a payment: which way its
// authorization went, in words. None when the response has no
// authorization key (an API older than transfer authorization).
func approvalNote(body any) []string {
	payment, ok := body.(*object)
	if !ok {
		return nil
	}
	value, ok := payment.Get("authorization")
	if !ok {
		return nil
	}
	authorization, ok := value.(*object)
	if !ok {
		return []string{"Approval: no transfer authorizer was enrolled when this payment was created; it went to your approvers"}
	}

	if reason := field(authorization, "refusal_reason"); reason != "" {
		words, known := refusalReasons[reason]
		if !known {
			return []string{"Approval: sent to your approvers: " + reason}
		}
		return []string{"Approval: sent to your approvers: " + words + " (" + reason + ")"}
	}
	switch status := field(authorization, "status"); status {
	case "pending":
		return []string{"Approval: challenge sent to your authorizer (expires " + field(authorization, "expires_at") + ")"}
	default:
		return []string{"Approval: " + status}
	}
}

// authorizerNote summarizes GET /api/transfer_authorizer: status, limits,
// the last 24 hours' usage and the signing secret's expiry.
func authorizerNote(body any) []string {
	authorizer, ok := body.(*object)
	if !ok {
		return nil
	}
	currency := field(authorizer, "currency_code")

	status := "Transfer authorizer: " + field(authorizer, "status")
	if reason := field(authorizer, "suspension_reason"); reason != "" {
		if words, known := suspensionReasons[reason]; known {
			reason += ": " + words
		}
		status += " (" + reason + ")"
	}

	dailyLimit, used := field(authorizer, "daily_limit"), field(authorizer, "daily_authorized_total")
	usage := "Last 24 hours: " + used + " " + currency + " authorized"
	if remaining, ok := decimalRemaining(dailyLimit, used); ok {
		usage += ", " + remaining + " " + currency + " remaining"
	}

	expiresAt := field(authorizer, "secret_expires_at")
	expiry := "Secret expires: " + expiresAt
	if at, err := time.Parse(time.RFC3339, expiresAt); err == nil {
		switch left := time.Until(at); {
		case left <= 0:
			expiry += " (expired: an approver rotates it in the app and resumes)"
		case left <= secretExpiryWarning:
			expiry += " (within 7 days: an approver rotates it in the app)"
		}
	}

	return []string{
		status,
		"Limits: " + field(authorizer, "per_transfer_limit") + " " + currency + " per transfer, " +
			dailyLimit + " " + currency + " per 24 hours",
		usage,
		expiry,
		"Webhook endpoint: " + field(authorizer, "webhook_endpoint_id"),
	}
}

// decimalRemaining is limit - used (never below zero) as a decimal string
// with as many places as the more precise input. The API sends amounts as
// decimal strings; they never go through float64.
func decimalRemaining(limit, used string) (string, bool) {
	l, okL := new(big.Rat).SetString(limit)
	u, okU := new(big.Rat).SetString(used)
	if !okL || !okU {
		return "", false
	}
	remaining := new(big.Rat).Sub(l, u)
	if remaining.Sign() < 0 {
		remaining.SetInt64(0)
	}
	return remaining.FloatString(max(decimalPlaces(limit), decimalPlaces(used))), true
}

func decimalPlaces(value string) int {
	if _, fraction, ok := strings.Cut(value, "."); ok {
		return len(fraction)
	}
	return 0
}

// field is a string field of a response object; "" when absent or null.
func field(o *object, key string) string {
	value, _ := o.Get(key)
	if value == nil {
		return ""
	}
	return jsString(value)
}
