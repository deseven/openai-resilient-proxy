const endpoints = {
    "/v1": { // this will add a /v1/chat/completions endpoint
        mode: "ordered", // "ordered" (default) or "random", determines how to pick providers from the list
        api_key: "some-api-key", // endpoint-specific API key, in addition to the global MASTER_API_KEY from .env
        providers: [ // all requests to this endpoint will use these providers
            { // this one will be used by default since it's the first one and our mode is "ordered"
                name: "OpenRouter",                           // just a name, used in the logs
                api_endpoint: "https://openrouter.ai/api/v1", // OpenAI-compatible API endpoint
                api_key: "some-api-key",                      // your API key for this provider
                timeout: 20000,                               // timeout in ms for one try, default 30000
                retries: 1                                    // number of retries, default 0
            },
            { // this one will be used if the first one failed
                name: "Together",
                api_endpoint: "https://api.together.xyz/v1",
                api_key: "some-api-key",
            }
        ]
    },
    "/forced-model": { // an example on enforcing the model in the incoming requests 
        providers: [
            {
                name: "DeepSeek V3",
                api_endpoint: "https://api.deepseek.com",
                api_key: "some-api-key",
                model: "deepseek-chat",                       // the model in all requests will be replaced with this one
                timeout: 30000
            }
        ]
    }
};
module.exports = { endpoints };