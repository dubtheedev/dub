// Package preview talks to the host app's /__dub/version endpoint.
package preview

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Client reads the deployed SHA from a preview.
type Client struct {
	HTTP *http.Client
}

var defaultClient = &Client{HTTP: &http.Client{Timeout: 30 * time.Second}}

// Version returns the SHA the preview reports. It refuses when the x-dub-sha
// header and the JSON body disagree.
func (c *Client) Version(ctx context.Context, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(url, "/")+"/__dub/version", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("GET /__dub/version: %s", resp.Status)
	}
	var v struct {
		SHA *string `json:"sha"`
	}
	if err := json.Unmarshal(body, &v); err != nil {
		return "", fmt.Errorf("GET /__dub/version: not JSON: %w", err)
	}
	sha := ""
	if v.SHA != nil {
		sha = *v.SHA
	}
	if h := resp.Header.Get("x-dub-sha"); h != "" && sha != "" && h != sha {
		return "", fmt.Errorf("preview is inconsistent: x-dub-sha header %s but body %s", h, sha)
	}
	if sha == "" {
		return "", fmt.Errorf("preview reports no SHA (GIT_SHA unset at build?)")
	}
	return sha, nil
}

// Version with the default client.
func Version(ctx context.Context, url string) (string, error) {
	return defaultClient.Version(ctx, url)
}

// Warm polls /__dub/version until it answers, for machines that scale to
// zero. Backoff starts at 2s and doubles to 20s; it gives up after maxWait.
func (c *Client) Warm(ctx context.Context, url string, maxWait time.Duration) (string, error) {
	deadline := time.Now().Add(maxWait)
	wait := 2 * time.Second
	var last error
	for {
		sha, err := c.Version(ctx, url)
		if err == nil {
			return sha, nil
		}
		last = err
		if time.Now().Add(wait).After(deadline) {
			return "", fmt.Errorf("preview did not answer within %s: %w", maxWait, last)
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(wait):
		}
		if wait < 20*time.Second {
			wait *= 2
		}
	}
}

// Warm with the default client and a 3 minute budget.
func Warm(ctx context.Context, url string) (string, error) {
	return defaultClient.Warm(ctx, url, 3*time.Minute)
}
