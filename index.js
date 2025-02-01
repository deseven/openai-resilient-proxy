require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const winston = require('winston');
const prettyjson = require('prettyjson');

// -- Winston Logger --
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const logger = winston.createLogger({
    level: LOG_LEVEL,
    format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.align(),
        winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] [${level}]: ${message}`)
    ),
    transports: [
        new winston.transports.Console()
    ]
});

// Override native console methods to use Winston
console.log = (...args) => logger.debug(args.join(' '));
console.info = (...args) => logger.info(args.join(' '));
console.warn = (...args) => logger.warn(args.join(' '));
console.error = (...args) => logger.error(args.join(' '));
console.debug = (...args) => logger.debug(args.join(' '));

// Helper to obfuscate sensitive strings.
function obfuscate(value) {
    if (!value) return '';
    if (value.length < 16) return '*'.repeat(value.length);
    return value.substring(0, 4) + '...' + value.substring(value.length - 4);
}

logger.info('Starting up...');

// Load environment variables
const {
    MASTER_API_KEY,
    API_PORT = 8010,
    DEAD_PROVIDER_CHECK_PERIOD = 10,
} = process.env;

// Validate API_KEY
if (!MASTER_API_KEY || MASTER_API_KEY.length < 16) {
    console.error('MASTER_API_KEY is required and must be at least 16 characters long.');
    process.exit(1);
}

// Load endpoints from openai-endpoints.js
let endpoints;
try {
    endpoints = require('./openai-endpoints.js').endpoints;
    
    // 1. There should be at least one endpoint defined.
    if (typeof endpoints !== 'object' || Object.keys(endpoints).length === 0) {
        throw new Error('endpoints configuration is empty or invalid.');
    }

    // 2. Every endpoint should have at least one provider defined.
    for (const [endpoint, config] of Object.entries(endpoints)) {

        // Validate mode
        if (config.mode !== undefined && !['ordered', 'random'].includes(config.mode)) {
            throw new Error(`endpoint "${endpoint}" has invalid "mode". It must be either "ordered" or "random".`);
        }

        if (!Array.isArray(config.providers) || config.providers.length === 0) {
            throw new Error(`endpoint "${endpoint}" must have at least one provider defined.`);
        }

        // 3. If endpoint-specific api_key is defined, it should be at least 16 symbols long and without any spaces.
        if (config.api_key) {
            if (typeof config.api_key !== 'string') {
                throw new Error(`endpoint "${endpoint}" has an invalid api_key; it must be a string.`);
            }
            if (config.api_key.length < 16) {
                throw new Error(`endpoint "${endpoint}" api_key must be at least 16 characters long.`);
            }
            if (/\s/.test(config.api_key)) {
                throw new Error(`endpoint "${endpoint}" api_key must not contain spaces.`);
            }
        }

        // 4. For each provider, validate required and optional fields.
        for (const provider of config.providers) {
            // 4a. name is required (any non-empty string).
            if (!provider.name || typeof provider.name !== 'string' || !provider.name.trim()) {
                throw new Error(`provider in endpoint "${endpoint}" is missing a valid "name".`);
            }

            // 4b. api_endpoint is required and should start with http.
            if (!provider.api_endpoint || typeof provider.api_endpoint !== 'string' || !provider.api_endpoint.startsWith('http')) {
                throw new Error(`provider "${provider.name}" in endpoint "${endpoint}" has an invalid "api_endpoint". It must start with "http".`);
            }

            // 4c. api_key is required (any non-empty string).
            if (!provider.api_key || typeof provider.api_key !== 'string' || !provider.api_key.trim()) {
                throw new Error(`provider "${provider.name}" in endpoint "${endpoint}" is missing a valid "api_key".`);
            }

            // 4d. model is optional, but if defined should be a non-empty string with [a-zA-Z0-9-_].
            if (provider.model !== undefined) {
                if (typeof provider.model !== 'string' || !provider.model.trim() || !/^[a-zA-Z0-9-_]+$/.test(provider.model)) {
                    throw new Error(`provider "${provider.name}" in endpoint "${endpoint}" has an invalid "model". It must be a non-empty string of [a-zA-Z0-9-_].`);
                }
            }

            // 4e. timeout is optional, but if defined should be a number bigger than 500.
            if (provider.timeout !== undefined) {
                if (typeof provider.timeout !== 'number' || provider.timeout <= 500) {
                    throw new Error(`provider "${provider.name}" in endpoint "${endpoint}" has an invalid "timeout". It must be a number greater than 500.`);
                }
            }
        }
    }
} catch (err) {
    logger.error(`Failed to load or validate endpoints from openai-endpoints.js: ${err.message}`);
    process.exit(1);
}

// Initialize provider states per endpoint
const providerStates = {};
for (const endpoint in endpoints) {
    if (Array.isArray(endpoints[endpoint].providers) && endpoints[endpoint].providers.length > 0) {
        providerStates[endpoint] = {
            mode: endpoints[endpoint].mode || 'ordered',
            providers: endpoints[endpoint].providers.map(provider => ({
                name: provider.name,
                api_endpoint: provider.api_endpoint,
                api_key: provider.api_key,
                model: provider.model,
                timeout: provider.timeout || 30000,
                isDead: false,
                lastUsedAt: null
            }))
        };
    } else {
        console.warn(`Endpoint "${endpoint}" has no providers or invalid configuration, skipping.`);
    }
}

// -- Display settings on startup --
const settings = {
    LOG_LEVEL,
    API_KEY: obfuscate(MASTER_API_KEY),
    API_PORT,
    DEAD_PROVIDER_CHECK_PERIOD: (DEAD_PROVIDER_CHECK_PERIOD || 'disabled'),
    ENDPOINTS: Object.fromEntries(
        Object.entries(endpoints).map(([route, endpointConfig]) => [
            route,
            {
                mode: endpointConfig.mode || 'ordered',
                api_key: endpointConfig.api_key ? obfuscate(endpointConfig.api_key) : undefined,
                providers: Object.fromEntries(
                    endpointConfig.providers.map(provider => [
                        provider.name,
                        {
                            api_endpoint: provider.api_endpoint,
                            api_key: obfuscate(provider.api_key),
                            model: provider.model ? provider.model : undefined,
                            timeout: `${(provider.timeout || 30000) / 1000}s`,
                        },
                    ])
                )
            }
        ])
    )
};
logger.info(`=== Startup Settings ===\n${prettyjson.render(settings, { noColor: true, inlineArrays: true })}`);

// Express app setup
const app = express();
app.use(express.json());

// Middleware for API key authentication (applies to all routes except /health)
app.use((req, res, next) => {
    if (req.path === '/health') {
        return next();
    }

    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || req.socket.remoteAddress;

    if (req.path === '/status') {
        if (token !== MASTER_API_KEY) {
            logger.warn(`Unauthorized access attempt from ${ip} to ${req.originalUrl}`);
            return res.status(401).json({ error: 'Unauthorized' });
        }
        return next();
    }

    // Extract the endpoint from the request path
    const endpointMatch = req.path.match(/^\/[^\/]+/);
    const endpoint = endpointMatch ? endpointMatch[0] : '';

    // Get the endpoint-specific api_key, if any
    const endpointConfig = endpoints[endpoint];
    const endpointApiKey = endpointConfig && endpointConfig.api_key;

    if (token !== MASTER_API_KEY && token !== endpointApiKey) {
        logger.warn(`Unauthorized access attempt from ${ip} to ${req.originalUrl}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
});

// Utility function to select the next available provider for a given endpoint
function getAvailableProviders(endpoint) {
    const { mode, providers } = providerStates[endpoint];
    let available = providers.filter(provider => !provider.isDead);

    if (mode === 'random') {
        // Shuffle the available providers
        for (let i = available.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [available[i], available[j]] = [available[j], available[i]];
        }
    }

    return available;
}

// Function to make a simple health check call
async function healthCheck(endpoint, provider) {
    try {
        const client = new OpenAI({
            apiKey: provider.api_key,
            baseURL: provider.api_endpoint,
            timeout: provider.timeout,
        });

        await client.chat.completions.create({
            model: provider.model,
            messages: [{ role: 'system', content: 'say hello' }],
            stream: false,
        });

        logger.info(`Provider "${provider.name}" for endpoint "${endpoint}" is back online.`);
        provider.isDead = false;
    } catch (err) {
        logger.debug(`Health check failed for provider "${provider.name}" on endpoint "${endpoint}": ${err.message}`);
    }
}

// Set up routes dynamically based on endpoints
for (const endpoint in providerStates) {
    const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;

    app.post(`${normalizedEndpoint}/chat/completions`, async (req, res) => {
        const requestBody = req.body;
        console.log(JSON.stringify(requestBody));

        if (!requestBody?.messages || !Array.isArray(requestBody.messages)) {
            return res.status(400).json({ error: 'Invalid request body' });
        }

        let availableProviders = getAvailableProviders(normalizedEndpoint);
        if (availableProviders.length === 0) {
            logger.error(`All providers dead for ${normalizedEndpoint}`);
            return res.status(500).json({ error: 'No available providers' });
        }

        for (const provider of availableProviders) {
            logger.info(`Trying ${provider.name} for ${normalizedEndpoint}`);
            provider.lastUsedAt = Date.now();
            const client = new OpenAI({
                apiKey: provider.api_key,
                baseURL: provider.api_endpoint,
                timeout: provider.timeout,
            });

            try {
                if (requestBody.stream) {
                    const streamOptions = {
                        ...requestBody,
                        ...(provider.model ? { model: provider.model } : {}),
                        stream: true,
                    };
                    const stream = await client.chat.completions.create(streamOptions);

                    // Set streaming headers
                    res.setHeader('Content-Type', 'text/event-stream');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.setHeader('Connection', 'keep-alive');
                    res.flushHeaders();

                    try {
                        for await (const chunk of stream) {
                            logger.debug(`data: ${JSON.stringify(chunk)}\n\n`);
                            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        }
                        res.write('data: [DONE]\n\n');
                        res.end();
                        logger.info(`Finished stream from ${provider.name} for ${normalizedEndpoint}`);
                        return;
                    } catch (streamErr) {
                        logger.error(`Stream error from ${provider.name}: ${streamErr.message}`);
                        provider.isDead = true;
                        res.end();
                        return;
                    }
                } else {
                    const completionOptions = {
                        ...requestBody,
                        ...(provider.model ? { model: provider.model } : {}),
                        stream: false,
                    };
                    const completion = await client.chat.completions.create(completionOptions);
                    logger.info(`Returning answer from ${provider.name} for ${normalizedEndpoint}`);
                    return res.json(completion);
                }
            } catch (err) {
                // Handle API errors
                if (err instanceof OpenAI.APIError) {
                    // Mark provider dead for auth/rate limit/server errors
                    if ([401, 403, 429, 500, 503].includes(err.status)) {
                        logger.warn(`Marking ${provider.name} dead (${err.status})`);
                        provider.isDead = true;
                    } else {
                        // Forward client errors (400, 404 etc)
                        return res.status(err.status).json({ error: err.message });
                    }
                } else {
                    // Network/timeout errors
                    logger.warn(`Network error for ${provider.name}: ${err.message}`);
                    provider.isDead = true;
                }
            }
        }

        // All providers failed
        logger.error(`All providers failed for ${normalizedEndpoint}`);
        res.status(500).json({ error: 'All providers failed' });
    });
}

// Periodically check dead providers
if (DEAD_PROVIDER_CHECK_PERIOD > 0) {
    setInterval(() => {
        for (const endpoint in providerStates) {
            const { mode, providers } = providerStates[endpoint];
            const deadProviders = providers.filter(provider => provider.isDead);
            deadProviders.forEach(provider => healthCheck(endpoint, provider));
        }
    }, DEAD_PROVIDER_CHECK_PERIOD * 60 * 1000);
}

// Health check
app.get('/health', (req, res) => {
    res.send('OK');
});

// Status check
app.get('/status', (req, res) => {
    const status = {};
    for (const endpoint in providerStates) {
        status[endpoint] = providerStates[endpoint].providers.map(provider => ({
            name: provider.name,
            isDead: provider.isDead,
            lastUsedAt: provider.lastUsedAt ? new Date(provider.lastUsedAt).toISOString() : null
        }));
    }
    res.send(JSON.stringify(status, null, 2));
});

// Start the Express server
app.listen(API_PORT, () => {
    console.info(`OpenAI Resilient Proxy is running on port ${API_PORT}`);
    console.info(`Available endpoints: ${Object.keys(providerStates).join(', ')}`);
});