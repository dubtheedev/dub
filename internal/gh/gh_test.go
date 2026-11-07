package gh

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoginAndLoad(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("DUB_TOKEN", "")
	var out strings.Builder
	p, err := Login("https://w/", strings.NewReader("  tok123\n"), &out)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "https://w/auth/login?cli=1") {
		t.Error(out.String())
	}
	st, _ := os.Stat(p)
	if st.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", st.Mode())
	}
	c, err := LoadCredentials("")
	if err != nil || c.Token != "tok123" || c.WorkerURL != "https://w" {
		t.Fatal(c, err)
	}
	if _, err := Login("https://w", strings.NewReader("\n"), &out); err == nil {
		t.Error("want error on empty token")
	}
}

func TestCreatePR(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/prs" || r.Header.Get("Authorization") != "Bearer t" {
			w.WriteHeader(401)
			return
		}
		var req PRRequest
		json.NewDecoder(r.Body).Decode(&req)
		if req.Head != "feat" || req.Base != "main" {
			w.WriteHeader(400)
			return
		}
		w.Write([]byte(`{"number":9,"url":"https://github.com/o/r/pull/9"}`))
	}))
	defer srv.Close()
	res, err := CreatePR(context.Background(), srv.Client(), &Credentials{WorkerURL: srv.URL, Token: "t"}, PRRequest{Owner: "o", Repo: "r", Head: "feat", Base: "main", Title: "x"})
	if err != nil || res.Number != 9 {
		t.Fatal(res, err)
	}
}

func TestInit(t *testing.T) {
	repo := t.TempDir()
	os.MkdirAll(filepath.Join(repo, ".dub"), 0o755)
	os.WriteFile(filepath.Join(repo, ".dub/rubric.md"), []byte("mine"), 0o644)
	created, err := Init(repo)
	if err != nil {
		t.Fatal(err)
	}
	if len(created) != 5 {
		t.Errorf("created %v", created)
	}
	b, _ := os.ReadFile(filepath.Join(repo, ".dub/rubric.md"))
	if string(b) != "mine" {
		t.Error("overwrote existing rubric")
	}
	if _, err := os.Stat(filepath.Join(repo, ".dub/config.yml")); err != nil {
		t.Error(err)
	}
	gi, _ := os.ReadFile(filepath.Join(repo, ".gitignore"))
	if string(gi) != ".dub-out/\n" {
		t.Errorf("gitignore %q", gi)
	}
	if again, _ := Init(repo); len(again) != 0 {
		t.Errorf("second init created %v", again)
	}
}
