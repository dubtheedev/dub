// Command dub packs and publishes dub requests.
package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime/debug"
	"strings"
	"time"

	"github.com/dubtheedev/dub/internal/brief"
	"github.com/dubtheedev/dub/internal/bundle"
	"github.com/dubtheedev/dub/internal/gh"
	"github.com/dubtheedev/dub/internal/preview"
	"github.com/dubtheedev/dub/internal/publish"
	"github.com/dubtheedev/dub/internal/runner"
)

var version = "dev"

const usage = `dub — product acceptance for agent-written work

  dub init                              write .dub/ starter files
  dub pack --preview <url> [flags]      capture evidence into a bundle
  dub publish [--bundle dir]            upload a bundle to the Worker
  dub pr --title <t> [--body <b>] [--base main]   open the PR as the Dub App
  dub login                             store a CLI token for pr/publish
  dub version

Environment: DUB_WORKER_URL, DUB_RUNNER, DUB_TOKEN, DUB_AUTHOR_{KIND,AGENT,SESSION},
GITHUB_REPOSITORY and GITHUB_REF (inside Actions).
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "init":
		err = cmdInit(os.Args[2:])
	case "pack":
		err = cmdPack(os.Args[2:])
	case "publish":
		err = cmdPublish(os.Args[2:])
	case "pr":
		err = cmdPR(os.Args[2:])
	case "login":
		err = cmdLogin(os.Args[2:])
	case "version", "--version", "-v":
		fmt.Println("dub", resolvedVersion())
	case "help", "-h", "--help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "dub: unknown command %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "dub:", err)
		os.Exit(1)
	}
}

func repoRoot() (string, error) {
	out, err := exec.Command("git", "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return "", fmt.Errorf("not inside a git repository")
	}
	return strings.TrimSpace(string(out)), nil
}

func cmdInit(args []string) error {
	fs := flag.NewFlagSet("init", flag.ExitOnError)
	fs.Parse(args)
	root, err := repoRoot()
	if err != nil {
		return err
	}
	created, err := gh.Init(root)
	for _, c := range created {
		fmt.Println("created", c)
	}
	if err == nil && len(created) == 0 {
		fmt.Println(".dub/ already set up")
	}
	return err
}

func cmdPack(args []string) error {
	fs := flag.NewFlagSet("pack", flag.ExitOnError)
	previewURL := fs.String("preview", "", "preview URL (required)")
	out := fs.String("out", "", "bundle output dir (default .dub-out)")
	briefPath := fs.String("brief", "", "brief path (default: the one brief changed on this branch)")
	image := fs.String("runner", "", "runner image (default $DUB_RUNNER or "+runner.DefaultImage+")")
	repoName := fs.String("repo", "", "owner/name (default $GITHUB_REPOSITORY)")
	prNum := fs.Int("pr", 0, "PR number (default from $GITHUB_REF)")
	base := fs.String("base", "", "base branch (default from .dub/config.yml or main)")
	fs.Parse(args)
	if *previewURL == "" {
		return fmt.Errorf("--preview is required")
	}
	root, err := repoRoot()
	if err != nil {
		return err
	}
	if *out == "" {
		*out = filepath.Join(root, ".dub-out")
	}
	if *base == "" {
		*base = baseBranch(root)
	}
	envRepo, envPR := bundle.RepoAndPRFromEnv()
	if *repoName == "" {
		*repoName = envRepo
	}
	if *prNum == 0 {
		*prNum = envPR
	}
	if *repoName == "" || *prNum == 0 {
		return fmt.Errorf("need --repo owner/name and --pr N outside of a pull_request job")
	}
	if err := runner.CheckDocker(); err != nil {
		return err
	}

	// 1. The brief.
	b, err := brief.Pick(root, *base, *briefPath)
	if err != nil {
		return err
	}
	head, err := bundle.HeadSHA(root)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "brief %s (%d criteria), HEAD %s\n", b.ID, len(b.Criteria), short(head))
	specs, err := bundle.SpecsFor(root, b.ID)
	if err != nil {
		return err
	}
	if len(specs) == 0 {
		fmt.Fprintf(os.Stderr, "no specs for this brief (.dub/evidence/%s.spec.ts or .dub/evidence/%s/); every criterion will be none\n", b.ID, b.ID)
	} else {
		fmt.Fprintf(os.Stderr, "specs: %s\n", strings.Join(specs, ", "))
	}

	// 2. Warm the preview and pin its SHA.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	fmt.Fprintf(os.Stderr, "warming %s …\n", *previewURL)
	before, err := preview.Warm(ctx, *previewURL)
	if err != nil {
		return err
	}
	if before != head {
		return fmt.Errorf("refusing to pack: preview runs %s but HEAD is %s", short(before), short(head))
	}

	// 3. Run the specs.
	var crit []runner.Criterion
	for _, c := range b.Criteria {
		crit = append(crit, runner.Criterion{ID: c.ID, Kind: c.Kind})
	}
	runOut := filepath.Join(*out, "runner")
	os.RemoveAll(runOut)
	img := *image
	if img == "" {
		img = os.Getenv("DUB_RUNNER")
	}
	if img == "" {
		img = runner.DefaultImage
	}
	fmt.Fprintf(os.Stderr, "running %s (workers: 1) …\n", img)
	res, err := runner.Default.Run(runner.Options{Repo: root, Out: runOut, PreviewURL: *previewURL, SHA: head, Criteria: crit, Image: img, Specs: specs})
	if err != nil {
		return err
	}
	digest, ok := runner.Default.Digest(img)
	if !ok {
		fmt.Fprintf(os.Stderr, "warning: could not resolve the runner digest; recording the tag %s\n", img)
	}

	// 4. Did the preview move?
	moved := res.PreviewMoved
	after, err := preview.Version(ctx, *previewURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "warning: preview unreachable after the run (%v); marking preview_moved\n", err)
		moved = true
	} else if after != before {
		fmt.Fprintf(os.Stderr, "preview moved during capture: %s → %s; every status becomes error\n", short(before), short(after))
		moved = true
	}
	res.PreviewMoved = moved
	outcomes := runner.Map(crit, res)

	// 5. Assemble.
	os.RemoveAll(filepath.Join(*out, "evidence"))
	bb, err := bundle.Assemble(bundle.Inputs{
		Repo: root, Base: *base, RepoName: *repoName, PR: *prNum, SHA: head, Runner: digest,
		Preview:   bundle.Preview{URL: *previewURL, PreviewSHA: before, Moved: moved},
		Brief:     b,
		Specs:     specs,
		Outcomes:  outcomes,
		RunnerOut: runOut, BundleOut: *out,
	})
	if err != nil {
		return err
	}
	p, err := bb.Write(*out)
	if err != nil {
		return err
	}
	for _, c := range bb.Criteria {
		fmt.Fprintf(os.Stderr, "  %-8s %-6s %s\n", c.ID, c.Status, firstLine(c.Error))
	}
	fmt.Fprintf(os.Stderr, "bundle %s → %s\n", bb.BundleID, p)
	fmt.Println(p)
	return nil
}

func cmdPublish(args []string) error {
	fs := flag.NewFlagSet("publish", flag.ExitOnError)
	dir := fs.String("bundle", "", "bundle dir containing dub.json and evidence/ (default .dub-out)")
	worker := fs.String("worker", os.Getenv("DUB_WORKER_URL"), "Worker URL (default $DUB_WORKER_URL)")
	fs.Parse(args)
	if *dir == "" {
		root, err := repoRoot()
		if err != nil {
			return err
		}
		*dir = filepath.Join(root, ".dub-out")
	}
	c := &publish.Client{HTTP: &http.Client{Timeout: 10 * time.Minute}, WorkerURL: *worker}
	res, err := c.Upload(context.Background(), *dir)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "published bundle %s\n", res.BundleID)
	fmt.Println(res.URL)
	return nil
}

func cmdPR(args []string) error {
	fs := flag.NewFlagSet("pr", flag.ExitOnError)
	title := fs.String("title", "", "PR title (required)")
	body := fs.String("body", "", "PR body")
	base := fs.String("base", "", "base branch (default from .dub/config.yml or main)")
	head := fs.String("head", "", "head branch (default: current branch)")
	repoName := fs.String("repo", "", "owner/name (default: origin remote)")
	worker := fs.String("worker", os.Getenv("DUB_WORKER_URL"), "Worker URL")
	fs.Parse(args)
	if *title == "" {
		return fmt.Errorf("--title is required")
	}
	root, err := repoRoot()
	if err != nil {
		return err
	}
	if *base == "" {
		*base = baseBranch(root)
	}
	if *head == "" {
		out, err := exec.Command("git", "rev-parse", "--abbrev-ref", "HEAD").Output()
		if err != nil {
			return err
		}
		*head = strings.TrimSpace(string(out))
	}
	if *repoName == "" {
		*repoName, err = originRepo()
		if err != nil {
			return err
		}
	}
	owner, name, ok := strings.Cut(*repoName, "/")
	if !ok {
		return fmt.Errorf("--repo must be owner/name")
	}
	creds, err := gh.LoadCredentials(*worker)
	if err != nil {
		return err
	}
	res, err := gh.CreatePR(context.Background(), &http.Client{Timeout: time.Minute}, creds, gh.PRRequest{Owner: owner, Repo: name, Head: *head, Base: *base, Title: *title, Body: *body})
	if err != nil {
		return err
	}
	fmt.Println(res.URL)
	return nil
}

func cmdLogin(args []string) error {
	fs := flag.NewFlagSet("login", flag.ExitOnError)
	worker := fs.String("worker", os.Getenv("DUB_WORKER_URL"), "Worker URL")
	fs.Parse(args)
	if *worker == "" {
		return fmt.Errorf("set DUB_WORKER_URL or pass --worker")
	}
	p, err := gh.Login(*worker, os.Stdin, os.Stdout)
	if err != nil {
		return err
	}
	fmt.Printf("\nsaved %s\n", p)
	return nil
}

// baseBranch reads `base:` from .dub/config.yml, defaulting to main.
func baseBranch(root string) string {
	data, err := os.ReadFile(filepath.Join(root, ".dub", "config.yml"))
	if err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if k, v, ok := strings.Cut(line, ":"); ok && strings.TrimSpace(k) == "base" {
				if v, _, _ = strings.Cut(v, "#"); strings.TrimSpace(v) != "" {
					return strings.TrimSpace(v)
				}
			}
		}
	}
	return "main"
}

func originRepo() (string, error) {
	out, err := exec.Command("git", "remote", "get-url", "origin").Output()
	if err != nil {
		return "", fmt.Errorf("no origin remote; pass --repo owner/name")
	}
	return parseRemote(strings.TrimSpace(string(out)))
}

// parseRemote reads owner/name from an ssh or https GitHub remote.
func parseRemote(u string) (string, error) {
	raw := u
	u = strings.TrimSuffix(u, ".git")
	if i := strings.Index(u, "github.com"); i >= 0 {
		u = strings.TrimLeft(u[i+len("github.com"):], ":/")
	}
	parts := strings.Split(u, "/")
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		return "", fmt.Errorf("cannot read owner/name from origin %q; pass --repo", raw)
	}
	return parts[0] + "/" + parts[1], nil
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return s
}

func short(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}

// resolvedVersion is the -X main.version from a release build, or the module
// version Go recorded for a `go install …@latest`, so a binary that was never
// built by the Makefile still says which commit it is.
func resolvedVersion() string {
	if version != "dev" {
		return version
	}
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" && info.Main.Version != "(devel)" {
		return info.Main.Version
	}
	return version
}
