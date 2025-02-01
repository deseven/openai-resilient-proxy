# openai-resilient-proxy
This proxy is designed to be used as a simple health-aware gateway for OpenAI-compatible APIs. When receiving a chat completion request, it tries the API provider from a pre-defined list and if the provider fails to answer or returns an error, the proxy marks it as dead and tries the same request with another one. Dead providers will then be periodically checked for availability.

## Possible use-cases
- if there's software that only allows to set up one connection and you want to make it fault-tolerant
- if there's software that doesn't allow to set a model that you want
- if you want a simple load-balancing between several providers
- if you just want a single place for configuring and accessing all your API connections
- all of the above combined

## Requirements
 - access to OpenAI-compatible API endpoints
 - any environment that can run node.js
 - 64MB of RAM

## Installation
#### Prerequisites
1. Clone this repo or download the code archive.
2. Copy `.env.example` to `.env` and edit it, follow the comments.
3. Copy `openai-endpoints.json.example` to `openai-endpoints.json` and edit it how you need, adding as many endpoints and providers as you like.

#### With docker compose (recommended)
4. Run `docker compose up -d`.

#### Manually
5. Install node.js 22 (lower/higher versions could work too, untested).
6. Run `npm i`.
7. Run `npm run start`.

## Notes
 - it's recommended to put the proxy behind nginx or any other HTTP reverse proxy software
 - only `/chat/completions` endpoint is supported
 - there's a `/status` endpoint that outputs all defined endpoints and their providers with statuses
 - there's also a `/health` endpoint that could be used for monitoring, it doesn't require an API key

## Contributing
Contributions are welcome! Feel free to open an issue or submit a pull request.