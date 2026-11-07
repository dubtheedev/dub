// Package publish uploads a bundle to the Worker, authenticated with the
// job's Actions OIDC token (or a CLI token outside Actions).
package publish

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Audience the Worker expects in the OIDC token.
const Audience = "dubthee.dev"

// Client uploads bundles.
type Client struct {
	HTTP      *http.Client
	WorkerURL string
	// Token overrides discovery; tests and `DUB_TOKEN` use it.
	Token string
}

// Result is the Worker's answer.
type Result struct {
	BundleID string `json:"bundle_id"`
	URL      string `json:"url"`
}

// OIDCToken requests an Actions id token for Audience.
func OIDCToken(ctx context.Context, hc *http.Client) (string, error) {
	reqURL := os.Getenv("ACTIONS_ID_TOKEN_REQUEST_URL")
	reqTok := os.Getenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
	if reqURL == "" || reqTok == "" {
		return "", errors.New("not in GitHub Actions (ACTIONS_ID_TOKEN_REQUEST_URL unset); does the job have `id-token: write`?")
	}
	u, err := url.Parse(reqURL)
	if err != nil {
		return "", err
	}
	q := u.Query()
	q.Set("audience", Audience)
	u.RawQuery = q.Encode()
	req, _ := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	req.Header.Set("Authorization", "bearer "+reqTok)
	req.Header.Set("Accept", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("OIDC token request: %s: %s", resp.Status, strings.TrimSpace(string(b)))
	}
	var v struct {
		Value string `json:"value"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&v); err != nil {
		return "", err
	}
	return v.Value, nil
}

// Token picks the bearer: explicit, else DUB_TOKEN, else OIDC.
func (c *Client) token(ctx context.Context) (string, error) {
	if c.Token != "" {
		return c.Token, nil
	}
	if t := os.Getenv("DUB_TOKEN"); t != "" {
		return t, nil
	}
	return OIDCToken(ctx, c.HTTP)
}

// Upload sends <dir>/dub.json and a tar of <dir>/evidence.
func (c *Client) Upload(ctx context.Context, dir string) (*Result, error) {
	if c.WorkerURL == "" {
		return nil, errors.New("DUB_WORKER_URL is not set")
	}
	tok, err := c.token(ctx)
	if err != nil {
		return nil, err
	}
	manifest, err := os.ReadFile(filepath.Join(dir, "dub.json"))
	if err != nil {
		return nil, err
	}
	tarBytes, err := TarDir(filepath.Join(dir, "evidence"))
	if err != nil {
		return nil, err
	}
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("dub.json", "dub.json")
	fw.Write(manifest)
	fw, _ = mw.CreateFormFile("evidence.tar", "evidence.tar")
	fw.Write(tarBytes)
	mw.Close()

	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(c.WorkerURL, "/")+"/api/bundles", &body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("upload: %s: %s", resp.Status, strings.TrimSpace(string(rb)))
	}
	var r Result
	if err := json.Unmarshal(rb, &r); err != nil {
		return nil, fmt.Errorf("upload: bad response: %w", err)
	}
	return &r, nil
}

// TarDir tars a directory (paths relative to it). A missing dir is an empty tar.
func TarDir(dir string) ([]byte, error) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	if _, err := os.Stat(dir); err == nil {
		err = filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() {
				return err
			}
			rel, _ := filepath.Rel(dir, p)
			hdr, err := tar.FileInfoHeader(info, "")
			if err != nil {
				return err
			}
			hdr.Name = filepath.ToSlash(rel)
			hdr.ModTime = time.Unix(0, 0)
			hdr.Uid, hdr.Gid, hdr.Uname, hdr.Gname = 0, 0, "", ""
			if err := tw.WriteHeader(hdr); err != nil {
				return err
			}
			f, err := os.Open(p)
			if err != nil {
				return err
			}
			defer f.Close()
			_, err = io.Copy(tw, f)
			return err
		})
		if err != nil {
			return nil, err
		}
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
