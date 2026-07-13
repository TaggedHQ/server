# syntax=docker/dockerfile:1

# ---- build stage -----------------------------------------------------------
FROM golang:1.25-bookworm AS build
WORKDIR /src

# Cache modules first.
COPY go.mod go.sum ./
RUN go mod download

# Build a fully static binary (both storage backends are pure Go, no cgo).
# Version and build date are stamped in via ldflags since the container build
# has no .git. VERSION is passed by the release workflow (git tag); when unset,
# the default baked into the source is used.
ARG VERSION
COPY . .
RUN V="${VERSION#v}"; \
    CGO_ENABLED=0 go build -trimpath \
      -ldflags "-s -w \
        -X github.com/TaggedHQ/server/internal/server.BuildDate=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
        ${V:+-X github.com/TaggedHQ/server/internal/server.Version=$V}" \
      -o /tagged .

# ---- runtime stage ---------------------------------------------------------
# distroless/static is tiny and ships CA certificates (needed for Postgres TLS).
FROM gcr.io/distroless/static-debian12:latest

COPY --from=build /tagged /tagged

# Listen on all interfaces inside the container and keep data on a volume.
ENV TAGGED_BIND=0.0.0.0:8080 \
    TAGGED_DATADIR=/data

VOLUME ["/data"]
EXPOSE 8080

ENTRYPOINT ["/tagged"]
