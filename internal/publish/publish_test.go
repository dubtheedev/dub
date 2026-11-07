package publish

import (
	"archive/tar"
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestUpload(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "dub.json"), []byte(`{"version":0}`), 0o644)
	os.MkdirAll(filepath.Join(dir, "evidence/ac-1"), 0o755)
	os.WriteFile(filepath.Join(dir, "evidence/ac-1/a.png"), []byte("png"), 0o644)

	oidc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("audience") != Audience || r.Header.Get("Authorization") != "bearer rt" {
			w.WriteHeader(400)
			return
		}
		w.Write([]byte(`{"value":"jwt1"}`))
	}))
	defer oidc.Close()
	t.Setenv("ACTIONS_ID_TOKEN_REQUEST_URL", oidc.URL+"/tok")
	t.Setenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "rt")
	t.Setenv("DUB_TOKEN", "")

	var gotAuth string
	var names []string
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/bundles" {
			w.WriteHeader(404)
			return
		}
		gotAuth = r.Header.Get("Authorization")
		r.ParseMultipartForm(1 << 20)
		for _, fh := range r.MultipartForm.File["dub.json"] {
			names = append(names, fh.Filename)
		}
		for _, fh := range r.MultipartForm.File["evidence.tar"] {
			f, _ := fh.Open()
			b, _ := io.ReadAll(f)
			tr := tar.NewReader(bytes.NewReader(b))
			h, err := tr.Next()
			if err != nil || h.Name != "ac-1/a.png" {
				t.Errorf("tar: %v %v", h, err)
			}
			names = append(names, fh.Filename)
		}
		w.Write([]byte(`{"bundle_id":"01H","url":"https://dubthee.dev/r/o/r/pull/1"}`))
	}))
	defer worker.Close()

	c := &Client{HTTP: http.DefaultClient, WorkerURL: worker.URL + "/"}
	res, err := c.Upload(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if res.BundleID != "01H" || gotAuth != "Bearer jwt1" || len(names) != 2 {
		t.Errorf("%+v %q %v", res, gotAuth, names)
	}
}

func TestTokenPrecedence(t *testing.T) {
	t.Setenv("DUB_TOKEN", "cli")
	t.Setenv("ACTIONS_ID_TOKEN_REQUEST_URL", "")
	c := &Client{HTTP: http.DefaultClient}
	tok, err := c.token(context.Background())
	if err != nil || tok != "cli" {
		t.Fatal(tok, err)
	}
	t.Setenv("DUB_TOKEN", "")
	if _, err := c.token(context.Background()); err == nil {
		t.Fatal("want error outside Actions")
	}
}
