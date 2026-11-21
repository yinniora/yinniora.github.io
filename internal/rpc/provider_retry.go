package rpc

import (
	"encoding/json"
	"regexp"
	"strings"
)

var (
	connectErrorPattern      = regexp.MustCompile(`(?i)before (?:the )?secure TLS connection|\b(?:ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT)\b|connection refused|connect (?:timeout|timed out)|TLS handshake timeout`)
	permanentNetworkPattern  = regexp.MustCompile(`(?i)\b(?:ENOTFOUND|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT(?:_LOCALLY)?)\b|certificate (?:has )?expired|unable to verify (?:the )?first certificate|self[- ]signed certificate`)
	streamErrorPattern       = regexp.MustCompile(`(?i)stream ended (?:before (?:message_stop|a terminal response event)|without)|stream disconnected before completion|stream was interrupted|upstream_stream_read_error|\bUND_ERR_BODY_TIMEOUT\b|body timeout|cut short after the reply had begun`)
	timeoutErrorPattern      = regexp.MustCompile(`(?i)timed? out|timeout|\b(?:504|524)\b`)
	transportErrorPattern    = regexp.MustCompile(`(?i)\b(?:ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR_SOCKET)\b|socket hang up|socket disconnected|socket connection was closed|network socket|connection (?:error|lost)|network error|fetch failed|other side closed|reset before headers`)
	retryableProviderPattern = regexp.MustCompile(`(?i)overloaded|rate.?limit|too many requests|server_busy|temporarily unavailable|\b(?:429|500|502|503|520)\b`)
	terminalProviderPattern  = regexp.MustCompile(`(?i)insufficient|quota|balance|billing|payment|no credit|unauthorized|forbidden|invalid api key|model_not_found|not found|aborted|abort|cancell?ed|authentication|user interrupt|interrupted by (?:the )?user|request (?:was )?interrupted`)
)

// A generic reset or timeout does not establish whether the provider accepted
// the request. Only an explicit pre-connect failure uses Pi's full budget.
func providerRetryLimit(message string, nativeLimit int, outputStarted bool) int {
	if outputStarted || !isAutoRetryAllowed(message) {
		return 0
	}
	if connectErrorPattern.MatchString(message) {
		return max(1, nativeLimit)
	}
	return 1
}

func providerNetworkPhase(message string) string {
	switch {
	case permanentNetworkPattern.MatchString(message):
		return "connect"
	case terminalProviderPattern.MatchString(message):
		return ""
	case connectErrorPattern.MatchString(message):
		return "connect"
	case streamErrorPattern.MatchString(message):
		return "stream"
	case timeoutErrorPattern.MatchString(message):
		return "timeout"
	case transportErrorPattern.MatchString(message):
		return "transport"
	default:
		return ""
	}
}

func isTransientTransportError(message string) bool {
	return connectErrorPattern.MatchString(message) || transportErrorPattern.MatchString(message)
}

func isAutoRetryAllowed(message string) bool {
	if terminalProviderPattern.MatchString(message) || permanentNetworkPattern.MatchString(message) {
		return false
	}
	return isTransientTransportError(message) || streamErrorPattern.MatchString(message) ||
		timeoutErrorPattern.MatchString(message) || retryableProviderPattern.MatchString(message)
}

func hasStreamedOutput(event assistantMessageEvent) bool {
	switch event.Type {
	case "text_delta", "thinking_delta", "toolcall_delta":
		return strings.TrimSpace(event.Delta) != ""
	case "text_end", "thinking_end":
		return strings.TrimSpace(event.Content) != ""
	case "toolcall_end":
		return true
	default:
		return false
	}
}

func hasPartialOutput(blocks []json.RawMessage) bool {
	for _, block := range blocks {
		var content struct {
			Type, Text, Thinking, ThinkingSignature string
		}
		if json.Unmarshal(block, &content) != nil {
			continue
		}
		switch content.Type {
		case "toolCall", "image":
			return true
		case "thinking":
			if strings.TrimSpace(content.Thinking) != "" || content.ThinkingSignature != "" {
				return true
			}
		case "text":
			if strings.TrimSpace(content.Text) != "" {
				return true
			}
		}
	}
	return false
}
