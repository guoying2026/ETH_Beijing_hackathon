FROM --platform=linux/amd64 rust:1.82-bookworm AS builder

WORKDIR /app

# Install build dependencies
RUN (sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
     sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list) && \
    apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./

RUN mkdir src && echo "fn main() {}" > src/main.rs

RUN cargo fetch --locked

COPY src ./src

RUN touch src/main.rs

RUN cargo build --release --bin tlsn-verifier-server

FROM --platform=linux/amd64 debian:bookworm-slim

WORKDIR /app

ARG GIT_HASH=local
ENV GIT_HASH=${GIT_HASH}

# Install runtime dependencies
RUN (sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
     sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list) && \
    apt-get update && apt-get install -y \
    ca-certificates \
    libssl3 \
    iproute2 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/tlsn-verifier-server /app/tlsn-verifier-server

COPY config.yaml /app/config.yaml

EXPOSE 7047

CMD ["/app/tlsn-verifier-server"]