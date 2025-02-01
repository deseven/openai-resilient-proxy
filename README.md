# openai-resilient-proxy
This proxy is designed to be used as a simple health-aware gateway for OpenAI-compatible APIs. When receiving a chat completion request, it tries the API providers in the order you defined them and if the provider failed to answer or returned an error, the proxy marks it as dead and tries the same request with the next one. Dead providers will then be periodically checked for availability. You can also enforce the model for all incoming requests in case you use providers that have different models, this allows 

## Requirements
 - access to OpenAI-compatible API endpoints
 - any environment that can run node.js
 - 64MB of RAM

## Installation
#### Prerequisites
1. Clone this repo or download the code archive.
2. Copy `.env.example` to `.env` and edit it, follow the comments.
3. Copy `openai-providers.json.example` to `openai-providers.json` and edit it how you need, adding as many endpoints and providers as you like.

#### With docker compose (recommended)
4. Run `docker compose up -d`.

#### Manually
5. Install node.js 22 (lower/higher versions could work too, untested).
6. Run `npm i`.
7. Run `npm run start`.

#### Notes
 - only `/chat/completions` endpoint is supported
 - there's a `/health` endpoint that could be used for monitoring

## Contributing
Contributions are welcome! Feel free to open an issue or submit a pull request.