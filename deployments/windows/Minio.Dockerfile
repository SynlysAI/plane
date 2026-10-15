# Official source release: https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z
# Release commit: 9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a
FROM golang:1.24.8-alpine3.22 AS builder
ENV CGO_ENABLED=0 GOMAXPROCS=2 GOTOOLCHAIN=local
RUN go install -p 2 github.com/minio/minio@9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a

# Reuse the repository's already downloaded base image for local deployment.
FROM python:3.12.5-alpine
COPY --from=builder /go/bin/minio /usr/local/bin/minio
EXPOSE 9000 9090
ENTRYPOINT ["/usr/local/bin/minio"]
CMD ["server", "/export", "--console-address", ":9090"]
