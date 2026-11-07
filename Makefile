VERSION ?= dev
LDFLAGS := -X main.version=$(VERSION)

build:
	go build -ldflags '$(LDFLAGS)' -o dist/dub ./cmd/dub

test:
	go vet ./...
	go test ./...

runner:
	docker build -t ghcr.io/dubtheedev/runner:dev runner

.PHONY: build test runner
