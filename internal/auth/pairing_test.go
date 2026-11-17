package auth

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestPairingIsSingleUseAndKeepsBearerHttpOnly(t *testing.T) {
	a := New("long-lived-secret")
	link := a.PairingURL("https://example.com:8443/session?id=test.jsonl")
	if strings.Contains(link, "long-lived-secret") {
		t.Fatal("bearer leaked")
	}
	h := a.Wrap(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", link, nil)
	r.Header.Set("X-Forwarded-Proto", "https")
	h(w, r)
	if w.Code != 302 || w.Header().Get("Location") != "/session?id=test.jsonl" {
		t.Fatalf("not cleaned: %d %s", w.Code, w.Header())
	}
	c := w.Result().Cookies()
	if len(c) != 1 || !c[0].HttpOnly || !c[0].Secure || c[0].Value != "long-lived-secret" {
		t.Fatal("invalid secure cookie")
	}
	w = httptest.NewRecorder()
	h(w, httptest.NewRequest("GET", link, nil))
	if w.Code != 401 {
		t.Fatal("ticket reused")
	}
}

func TestExpiredPairingRejected(t *testing.T) {
	a := New("secret")
	link := a.PairingURL("http://127.0.0.1/")
	u, _ := url.Parse(link)
	a.pairs[u.Query().Get("pair")] = pairingTicket{expires: time.Now().Add(-time.Second), host: u.Host}
	w := httptest.NewRecorder()
	a.Wrap(func(w http.ResponseWriter, r *http.Request) { t.Fatal("expired ticket passed") })(w, httptest.NewRequest("GET", link, nil))
	if w.Code != 401 {
		t.Fatal(w.Code)
	}
}

func TestPairingBoundToDestinationHostAndPort(t *testing.T) {
	a := New("test-token")
	link := a.PairingURL("https://example.com:8443/")
	h := a.Wrap(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	for _, host := range []string{"other.example.com:8443", "example.com:9443"} {
		r := httptest.NewRequest("GET", link, nil)
		r.Host = host
		w := httptest.NewRecorder()
		h(w, r)
		if w.Code != 401 {
			t.Fatalf("accepted %s", host)
		}
	}
	w := httptest.NewRecorder()
	h(w, httptest.NewRequest("GET", link, nil))
	if w.Code != 302 {
		t.Fatal("wrong-host attempts consumed valid ticket")
	}
}

func TestTokenlessHandoverDoesNotMintTickets(t *testing.T) {
	a := New("")
	if got := a.PairingURL("http://localhost:31415/"); got != "http://localhost:31415/" || len(a.pairs) != 0 {
		t.Fatal("minted unnecessary ticket")
	}
}
