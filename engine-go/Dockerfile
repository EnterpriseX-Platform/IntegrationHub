FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /engine .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /engine /engine
ENV ENGINE_GO_ADDR=0.0.0.0:8140
EXPOSE 8140
ENTRYPOINT ["/engine"]
