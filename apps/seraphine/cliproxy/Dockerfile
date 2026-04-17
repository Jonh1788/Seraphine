# Custom build of CLIProxyAPI com patch que permite opt-out de cloaking
# via header X-CPA-No-Cloak: 1. Sem o opt-out, o proxy injeta system
# prompt + user_id dinâmicos que invalidam o `cache_control` de todas as
# chamadas, zerando hits de prompt caching.
#
# Rev fixada pra builds reproduzíveis. Bump manual quando quiser puxar
# novo upstream (e reconferir que o patch ainda aplica).

ARG CLIPROXY_REV=v6.9.28

FROM golang:1.26-alpine AS builder
RUN apk add --no-cache git ca-certificates
ARG CLIPROXY_REV
WORKDIR /src
RUN git clone --depth 1 --branch ${CLIPROXY_REV} \
      https://github.com/router-for-me/CLIProxyAPI.git . \
 || (git clone https://github.com/router-for-me/CLIProxyAPI.git . \
     && git checkout ${CLIPROXY_REV})

COPY no-cloak.patch /tmp/no-cloak.patch
RUN git apply /tmp/no-cloak.patch

RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux go build \
      -ldflags="-s -w -X 'main.Version=${CLIPROXY_REV}-seraphine-nocloak'" \
      -o ./CLIProxyAPI ./cmd/server/

FROM alpine:3.22
RUN apk add --no-cache tzdata ca-certificates wget
COPY --from=builder /src/CLIProxyAPI /CLIProxyAPI/CLIProxyAPI
WORKDIR /CLIProxyAPI
EXPOSE 8317
CMD ["./CLIProxyAPI"]
