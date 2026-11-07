package preview

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestVersion(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/__dub/version" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("x-dub-sha", "abc")
		w.Write([]byte(`{"sha":"abc"}`))
	}))
	defer srv.Close()
	sha, err := Version(context.Background(), srv.URL+"/")
	if err != nil || sha != "abc" {
		t.Fatal(sha, err)
	}
}

func TestVersionMismatch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("x-dub-sha", "def")
		w.Write([]byte(`{"sha":"abc"}`))
	}))
	defer srv.Close()
	if _, err := Version(context.Background(), srv.URL); err == nil || !strings.Contains(err.Error(), "inconsistent") {
		t.Fatal(err)
	}
}

func TestVersionNull(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"sha":null}`))
	}))
	defer srv.Close()
	if _, err := Version(context.Background(), srv.URL); err == nil {
		t.Fatal("want error on null sha")
	}
}

func TestWarm(t *testing.T) {
	var n int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&n, 1) < 3 {
			w.WriteHeader(503)
			return
		}
		w.Write([]byte(`{"sha":"abc"}`))
	}))
	defer srv.Close()
	c := &Client{HTTP: srv.Client()}
	// Shrink the backoff by using a tiny maxWait relative to the 2s start is
	// not possible; instead assert it gives up fast when told to.
	if _, err := c.Warm(context.Background(), srv.URL, 10*time.Millisecond); err == nil {
		t.Fatal("expected give-up")
	}
	atomic.StoreInt32(&n, 2)
	sha, err := c.Warm(context.Background(), srv.URL, time.Minute)
	if err != nil || sha != "abc" {
		t.Fatal(sha, err)
	}
}
