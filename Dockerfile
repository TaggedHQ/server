# syntax=docker/dockerfile:1

# ---- build stage -----------------------------------------------------------
FROM golang:1.25-bookworm AS build
WORKDIR /src

# Cache modules first.
COPY go.mod go.sum ./
RUN go mod download

# Build a fully static binary (both storage backends are pure Go, no cgo).
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /tagged .

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
