require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const winston = require('winston');
const fs = require('fs');
const path = require('path');
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
    API_KEY,
    API_PORT = 8010,
    DEAD_PROVIDER_CHECK_PERIOD = 60,
} = process.env;

// Validate API_KEY
if (!API_KEY || API_KEY.length < 16) {
    console.error('API_KEY is required and must be at least 16 characters long.');
    process.exit(1);
}

// Load providers from openai-providers.json
let providersConfig;
const providersPath = path.join(__dirname, 'openai-providers.json');
try {
    const data = fs.readFileSync(providersPath, 'utf-8');
    providersConfig = JSON.parse(data);
    if (typeof providersConfig !== 'object' || Object.keys(providersConfig).length === 0) {
        throw new Error('Providers configuration is empty or invalid.');
    }
} catch (err) {
    console.error(`Failed to load providers from ${providersPath}: ${err.message}`);
    process.exit(1);
}

// Initialize provider states per prefix
const providerStates = {};
for (const prefix in providersConfig) {
    if (typeof providersConfig[prefix] === 'object' && Object.keys(providersConfig[prefix]).length > 0) {
        providerStates[prefix] = Object.entries(providersConfig[prefix]).map(([name, provider]) => ({
            name,
            ...provider,
            timeout: provider.timeout || 30000,
            isDead: false,
            lastFailedAt: null,
        }));
    } else {
        console.warn(`Prefix "${prefix}" has no providers or invalid configuration, skipping.`);
    }
}

// -- Display settings on startup --
const settings = {
    LOG_LEVEL,
    API_KEY: obfuscate(API_KEY),
    API_PORT,
    DEAD_PROVIDER_CHECK_PERIOD: (DEAD_PROVIDER_CHECK_PERIOD || 'disabled'),
    PROVIDERS: Object.fromEntries(
        Object.entries(providersConfig).map(([route, providers]) => [
            route,
            Object.fromEntries(
                Object.entries(providers).map(([name, provider]) => [
                    name,
                    {
                        ...provider,
                        api_key: obfuscate(provider.api_key),
                        timeout: `${(provider.timeout || 30000) / 1000}s`,
                    },
                ])
            ),
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

    if (token !== API_KEY) {
        logger.warn(`Unauthorized access attempt from ${ip} to ${req.originalUrl}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
});

// Utility function to select the next available provider for a given prefix
function getAvailableProviders(prefix) {
    return providerStates[prefix].filter(provider => !provider.isDead);
}

// Function to make a simple health check call
async function healthCheck(prefix, provider) {
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
        
        logger.info(`Provider "${provider.name}" for prefix "${prefix}" is back online.`);
        provider.isDead = false;
        provider.lastFailedAt = null;
    } catch (err) {
        logger.debug(`Health check failed for provider "${provider.name}" on prefix "${prefix}": ${err.message}`);
    }
}

// Set up routes dynamically based on prefixes
for (const prefix in providerStates) {
    const normalizedPrefix = prefix.startsWith('/') ? prefix : `/${prefix}`;

    app.post(`${normalizedPrefix}/chat/completions`, async (req, res) => {
        const requestBody = req.body;
        console.log(JSON.stringify(requestBody));

        if (!requestBody?.messages || !Array.isArray(requestBody.messages)) {
            return res.status(400).json({ error: 'Invalid request body' });
        }

        let availableProviders = getAvailableProviders(normalizedPrefix);
        if (availableProviders.length === 0) {
            logger.error(`All providers dead for ${normalizedPrefix}`);
            return res.status(500).json({ error: 'No available providers' });
        }

        for (const provider of availableProviders) {
            logger.info(`Trying ${provider.name} for ${normalizedPrefix}`);
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
                        logger.info(`Finished stream from ${provider.name} for ${normalizedPrefix}`);
                        return;
                    } catch (streamErr) {
                        logger.error(`Stream error from ${provider.name}: ${streamErr.message}`);
                        provider.isDead = true;
                        provider.lastFailedAt = Date.now();
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
                    logger.info(`Returning answer from ${provider.name} for ${normalizedPrefix}`);
                    return res.json(completion);
                }
            } catch (err) {
                // Handle API errors
                if (err instanceof OpenAI.APIError) {
                    // Mark provider dead for auth/rate limit/server errors
                    if ([401, 403, 429, 500, 503].includes(err.status)) {
                        logger.warn(`Marking ${provider.name} dead (${err.status})`);
                        provider.isDead = true;
                        provider.lastFailedAt = Date.now();
                    } else {
                        // Forward client errors (400, 404 etc)
                        return res.status(err.status).json({ error: err.message });
                    }
                } else {
                    // Network/timeout errors
                    logger.warn(`Network error for ${provider.name}: ${err.message}`);
                    provider.isDead = true;
                    provider.lastFailedAt = Date.now();
                }
            }
        }

        // All providers failed
        logger.error(`All providers failed for ${normalizedPrefix}`);
        res.status(500).json({ error: 'All providers failed' });
    });
}

// Periodically check dead providers
setInterval(() => {
    for (const prefix in providerStates) {
        const deadProviders = providerStates[prefix].filter(provider => provider.isDead);
        deadProviders.forEach(provider => healthCheck(prefix, provider));
    }
}, DEAD_PROVIDER_CHECK_PERIOD * 60 * 1000);

// Health check
app.get('/health', (req, res) => {
    res.send('OK');
});

// Start the Express server
app.listen(API_PORT, () => {
    console.info(`OpenAI Proxy is running on port ${API_PORT}`);
    console.info(`Available prefixes: ${Object.keys(providerStates).join(', ')}`);
});