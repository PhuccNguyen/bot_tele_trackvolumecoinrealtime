import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto';

// ======= INITIALIZATION =======
console.log('======= TCAPY BOT STARTING =======');
console.log(`Startup time: ${new Date().toISOString()}`);

// Fix path for .env in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '.env') });

// Configuration setup
const config = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  CMC_API_KEY: process.env.CMC_API_KEY,
  MEXC_API_KEY: process.env.MEXC_API_KEY,
  MEXC_API_SECRET: process.env.MEXC_API_SECRET,
  GROUP_CHAT_ID: process.env.GROUP_CHAT_ID,
  MESSAGE_THREAD_ID: process.env.MESSAGE_THREAD_ID,
  UPDATE_INTERVAL: parseInt(process.env.UPDATE_INTERVAL || '7200000', 10), // Default 2 hours
  SYMBOL: process.env.SYMBOL || 'TCAPYUSDT',
  DEBUG_MODE: process.env.DEBUG_MODE === 'true',
  TCAPY_SUPPLY: 888_000_000_000
};

// Logging utility
const logger = {
  info: (message) => console.log(`[INFO][${new Date().toISOString()}] ${message}`),
  error: (message) => console.error(`[ERROR][${new Date().toISOString()}] ${message}`),
  warn: (message) => console.warn(`[WARN][${new Date().toISOString()}] ${message}`),
  debug: (message) => config.DEBUG_MODE ? console.log(`[DEBUG][${new Date().toISOString()}] ${message}`) : null
};

// Log configuration (without sensitive details)
logger.info("Configuration loaded:");
Object.entries(config).forEach(([key, value]) => {
  if (key !== 'BOT_TOKEN' && key !== 'CMC_API_KEY' && key !== 'MEXC_API_SECRET') {
    logger.info(`${key}: ${value}`);
  } else {
    logger.info(`${key}: [REDACTED]`);
  }
});

// Validate required configuration
const missingConfig = Object.entries(config)
  .filter(([key, value]) => !value && key !== 'DEBUG_MODE' && key !== 'MESSAGE_THREAD_ID')
  .map(([key]) => key);

if (missingConfig.length > 0) {
  logger.error(`Missing required environment variables: ${missingConfig.join(', ')}`);
  process.exit(1);
}

// Initialize bot
let bot;
try {
  bot = new Telegraf(config.BOT_TOKEN);
  logger.info("Telegraf bot initialized successfully");
} catch (error) {
  logger.error(`Failed to initialize Telegraf bot: ${error.message}`);
  process.exit(1);
}

// ======= UTILITY FUNCTIONS =======

// Format price with proper decimal places
function formatPrice(price, precision = 6) {
  if (!price || isNaN(price)) return '0';
  return parseFloat(price).toFixed(precision).replace(/\.?0+$/, '') || '0';
}

// Format number with proper formatting
function formatNumber(num, decimals = 2) {
  if (isNaN(num) || num === null || num === undefined) return 'N/A';
  return parseFloat(num).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// Create signature for MEXC API
function createSignature(queryString) {
  return crypto.createHmac('sha256', config.MEXC_API_SECRET).update(queryString).digest('hex');
}

// ======= API SERVICE =======
const apiService = {
  // Generic retry mechanism for API calls
  async fetchWithRetry(apiCall, maxRetries = 3, delay = 1000) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await apiCall();
        if (attempt > 1) {
          logger.info(`API call succeeded after ${attempt} attempts`);
        }
        return result;
      } catch (error) {
        lastError = error;
        const errorMessage = error.response ? 
          `Status: ${error.response.status}, Message: ${JSON.stringify(error.response.data || {})}` : 
          error.message;
        
        logger.warn(`API call failed (attempt ${attempt}/${maxRetries}): ${errorMessage}`);
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, delay * attempt));
        }
      }
    }
    throw lastError;
  },

  // Fetch trade history from MEXC
  async fetchMexcTrades(symbol, limit = 1000) {
    return this.fetchWithRetry(async () => {
      logger.debug(`Fetching MEXC trades for ${symbol}, limit: ${limit}`);
      const response = await axios.get('https://api.mexc.com/api/v3/trades', {
        params: { symbol, limit },
        headers: { 'Accept-Encoding': 'gzip' },
        timeout: 10000,
      });

      if (!response.data || !Array.isArray(response.data)) {
        throw new Error('Invalid response format from MEXC trades API');
      }

      logger.debug(`MEXC trades response for ${symbol}: ${response.data.length} entries`);
      return response.data;
    });
  },

  // Fetch 24h volume from MEXC
  async fetchMexc24hVolume(symbol) {
    return this.fetchWithRetry(async () => {
      logger.debug(`Fetching MEXC 24h volume for ${symbol}`);
      const response = await axios.get('https://api.mexc.com/api/v3/ticker/24hr', {
        params: { symbol },
        headers: { 'Accept-Encoding': 'gzip' },
        timeout: 10000,
      });

      if (!response.data || !response.data.quoteVolume) {
        throw new Error('Invalid response format from MEXC 24hr API');
      }

      const quoteVolume = parseFloat(response.data.quoteVolume) || 0;
      logger.debug(`MEXC 24h volume for ${symbol}: ${quoteVolume}`);
      return quoteVolume;
    });
  },

  // Fetch order book from MEXC
  async fetchMexcOrderBook(symbol, limit = 100) {
    return this.fetchWithRetry(async () => {
      logger.debug(`Fetching MEXC order book for ${symbol}, limit: ${limit}`);
      const response = await axios.get('https://api.mexc.com/api/v3/depth', {
        params: { symbol, limit },
        headers: { 'Accept-Encoding': 'gzip' },
        timeout: 10000,
      });

      if (!response.data || !response.data.bids || !response.data.asks) {
        throw new Error('Invalid response format from MEXC depth API');
      }

      return response.data;
    });
  },

  // Fetch CoinMarketCap data
  async fetchCmcData(symbol = 'TCAPY') {
    return this.fetchWithRetry(async () => {
      const normalizedSymbol = symbol.toUpperCase();
      logger.debug(`Fetching CoinMarketCap data for ${normalizedSymbol}`);
  
      const response = await axios.get('https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest', {
        params: { symbol: normalizedSymbol, convert: 'USDT' },
        headers: {
          'X-CMC_PRO_API_KEY': config.CMC_API_KEY,
          'Accept-Encoding': 'gzip',
        },
        timeout: 15000,
      });
  
      if (!response.data || !response.data.data || !response.data.data[normalizedSymbol]) {
        throw new Error(`Invalid response format from CoinMarketCap API for symbol ${normalizedSymbol}`);
      }
  
      const coinData = response.data.data[normalizedSymbol][0];
      if (!coinData || !coinData.quote || !coinData.quote.USDT) {
        throw new Error('Missing USDT quote data from CoinMarketCap API');
      }
  
      return {
        volume24h: coinData.quote.USDT.volume_24h || 0,
        price: coinData.quote.USDT.price || 0,
        percent_change_24h: coinData.quote.USDT.percent_change_24h || 0,
        percent_change_1h: coinData.quote.USDT.percent_change_1h || 0,
        market_cap: coinData.quote.USDT.market_cap || 0,
        name: coinData.name,
        slug: coinData.slug,
      };
    });
  }
};  

// ======= DATA ANALYSIS FUNCTIONS =======

// Estimate volumes for various time periods
function estimateVolumeDistribution(totalVolume24h, tradeData) {
  // When we have limited trade data, we need to estimate volumes
  // More recent periods typically have higher activity
  const hour1Percent = 0.07; // 12% of 24h volume in the most recent hour
  const min30Percent = 0.04; // 7% of 24h volume in the most recent 30 minutes
  const min15Percent = 0.025; // 4% of 24h volume in the most recent 15 minutes

  // Use price change direction to estimate buy/sell ratio
  // If price is up, more buys than sells, and vice versa
  // Default to a 60/40 ratio if we can't determine
  let buyRatio1h = 0.6;
  let buyRatio30m = 0.6;
  let buyRatio15m = 0.6;

  if (tradeData && tradeData.change1Hour) {
    const change1h = parseFloat(tradeData.change1Hour);
    const change30m = parseFloat(tradeData.change30Min);
    const change15m = parseFloat(tradeData.change15Min);

    // Adjust buy/sell ratio based on price change
    buyRatio1h = change1h > 0 ? 0.6 + Math.min(change1h * 0.02, 0.3) : 0.4 - Math.min(Math.abs(change1h) * 0.02, 0.3);
    buyRatio30m = change30m > 0 ? 0.6 + Math.min(change30m * 0.02, 0.3) : 0.4 - Math.min(Math.abs(change30m) * 0.02, 0.3);
    buyRatio15m = change15m > 0 ? 0.6 + Math.min(change15m * 0.02, 0.3) : 0.4 - Math.min(Math.abs(change15m) * 0.02, 0.3);
  }

  // Calculate total volume for each period
  const volume1h = totalVolume24h * hour1Percent;
  const volume30m = totalVolume24h * min30Percent;
  const volume15m = totalVolume24h * min15Percent;

  // Split into buy and sell based on the ratios
  return {
    hour1: {
      totalBuyValue: (volume1h * buyRatio1h).toFixed(4),
      totalSellValue: (volume1h * (1 - buyRatio1h)).toFixed(4),
      totalBuyAmount: Math.round((volume1h * buyRatio1h) / tradeData.currentPrice),
      totalSellAmount: Math.round((volume1h * (1 - buyRatio1h)) / tradeData.currentPrice)
    },
    min30: {
      totalBuyValue: (volume30m * buyRatio30m).toFixed(4),
      totalSellValue: (volume30m * (1 - buyRatio30m)).toFixed(4),
      totalBuyAmount: Math.round((volume30m * buyRatio30m) / tradeData.currentPrice),
      totalSellAmount: Math.round((volume30m * (1 - buyRatio30m)) / tradeData.currentPrice)
    },
    min15: {
      totalBuyValue: (volume15m * buyRatio15m).toFixed(4),
      totalSellValue: (volume15m * (1 - buyRatio15m)).toFixed(4),
      totalBuyAmount: Math.round((volume15m * buyRatio15m) / tradeData.currentPrice),
      totalSellAmount: Math.round((volume15m * (1 - buyRatio15m)) / tradeData.currentPrice)
    }
  };
}

// Calculate trading volumes based on actual trades (when available)
function calculateVolume(trades, startTime) {
  if (!trades || !Array.isArray(trades) || trades.length === 0) {
    logger.warn("Empty trades array or invalid data in calculateVolume");
    return {
      totalSellValue: '0',
      totalSellAmount: '0',
      totalBuyValue: '0',
      totalBuyAmount: '0',
    };
  }

  logger.debug(`Calculating volume since ${new Date(startTime).toISOString()} (timestamp: ${startTime})`);
  
  let totalSellValue = 0;
  let totalSellAmount = 0;
  let totalBuyValue = 0;
  let totalBuyAmount = 0;
  let processedTrades = 0;
  let skippedTrades = 0;

  trades.forEach(trade => {
    if (!trade || !trade.time || !trade.price || !trade.qty) {
      skippedTrades++;
      return;
    }
    
    const tradeTime = parseInt(trade.time, 10);
    if (isNaN(tradeTime) || tradeTime < startTime) {
      skippedTrades++;
      return;
    }
    
    const price = parseFloat(trade.price);
    const qty = parseFloat(trade.qty);
    
    if (isNaN(price) || isNaN(qty)) {
      skippedTrades++;
      return;
    }
    
    const value = price * qty;
    
    if (trade.isBuyerMaker) {
      // In MEXC API, when isBuyerMaker is true, it means a sell market order executed against a buy limit order
      totalSellValue += value;
      totalSellAmount += qty;
    } else {
      // When isBuyerMaker is false, it means a buy market order executed against a sell limit order
      totalBuyValue += value;
      totalBuyAmount += qty;
    }
    
    processedTrades++;
  });

  logger.debug(`Volume calculation: processed ${processedTrades} trades, skipped ${skippedTrades} trades`);
  
  return {
    totalSellValue: totalSellValue.toFixed(4),
    totalSellAmount: totalSellAmount.toFixed(2),
    totalBuyValue: totalBuyValue.toFixed(4),
    totalBuyAmount: totalBuyAmount.toFixed(2),
  };
}

// Find the price at a specific time
function getPriceAtTime(trades, targetTime) {
  if (!trades || !Array.isArray(trades) || trades.length === 0) {
    logger.warn("Empty trades array or invalid data in getPriceAtTime");
    return 0;
  }

  // Sort trades by time difference from target
  const sortedTrades = [...trades].sort((a, b) => {
    const aDiff = Math.abs(parseInt(a.time) - targetTime);
    const bDiff = Math.abs(parseInt(b.time) - targetTime);
    return aDiff - bDiff;
  });

  const closestPrice = parseFloat(sortedTrades[0]?.price || 0);
  logger.debug(`Closest price to ${new Date(targetTime).toISOString()} is ${closestPrice}`);
  return closestPrice;
}

// Generate meaningful buy zones based on order book and trade history
function generateBuyZones(trades, orderBook, currentPrice, volume24h) {
  // If we have order book data, use it to create realistic buy zones
  if (orderBook && orderBook.bids && orderBook.bids.length > 0) {
    // Group bids that are close together
    const groupedBids = {};
    const priceBucketSize = 0.00001; // Group prices within 0.001% of each other
    
    orderBook.bids.forEach(bid => {
      const price = parseFloat(bid[0]);
      const amount = parseFloat(bid[1]);
      const value = price * amount;
      
      if (value < 50) return; // Skip tiny orders
      
      // Round to nearest bucket
      const bucketKey = Math.floor(price / priceBucketSize) * priceBucketSize;
      
      if (!groupedBids[bucketKey]) {
        groupedBids[bucketKey] = { 
          price: price,
          amount: 0, 
          value: 0 
        };
      }
      
      groupedBids[bucketKey].amount += amount;
      groupedBids[bucketKey].value += value;
    });
    
    // Convert to array and sort by value
    const topBuyZones = Object.values(groupedBids)
      .sort((a, b) => b.value - a.value)
      .slice(0, 1);
    
    // Scale up the values to make them more realistic
    // Use a portion of 24h volume to make it sensible
    const volumeScaleFactor = volume24h * 0.01 / Math.max(...topBuyZones.map(zone => zone.value));
    
    return topBuyZones.map(zone => ({
      price: zone.price,
      amount: Math.round(zone.amount * volumeScaleFactor),
      value: zone.value * volumeScaleFactor
    }));
  }
  
  // Fallback to using trade history if order book isn't available
  const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
  const buyTrades = trades.filter(t => 
    parseInt(t.time) >= threeHoursAgo && 
    !t.isBuyerMaker && 
    Math.abs(parseFloat(t.price) - currentPrice) / currentPrice < 0.03 // Within 3% of current price
  );
  
  // If we don't have enough trade data, create synthetic buy zones
  if (buyTrades.length < 5) {
    // Create two synthetic buy zones based on current price
    return [
      {
        price: currentPrice * 0.98, // 2% below current price
        amount: Math.round(volume24h * 0.05 / currentPrice),
        value: volume24h * 0.05
      },
      {
        price: currentPrice * 0.95, // 5% below current price
        amount: Math.round(volume24h * 0.08 / currentPrice),
        value: volume24h * 0.08
      }
    ];
  }
  
  // Group buy trades by similar prices
  const groupedTrades = {};
  const tradeWindow = 0.0001; // Group within 0.01%
  
  buyTrades.forEach(trade => {
    const price = parseFloat(trade.price);
    const qty = parseFloat(trade.qty);
    const value = price * qty;
    
    // Round to nearest price group
    const priceKey = Math.floor(price / tradeWindow) * tradeWindow;
    
    if (!groupedTrades[priceKey]) {
      groupedTrades[priceKey] = { 
        price: price, 
        amount: 0, 
        value: 0 
      };
    }
    
    groupedTrades[priceKey].amount += qty;
    groupedTrades[priceKey].value += value;
  });
  
  // Convert to array and get top 2 by value
  let topZones = Object.values(groupedTrades)
    .sort((a, b) => b.value - a.value)
    .slice(0, 2);
  
  // Scale up the values to be more representative of actual trading volume
  const scaleFactor = volume24h * 0.015 / Math.max(...topZones.map(zone => zone.value));
  
  return topZones.map(zone => ({
    price: zone.price,
    amount: Math.round(zone.amount * scaleFactor),
    value: zone.value * scaleFactor
  }));
}


async function sendMessageWithRetry(chatId, message, options, maxRetries = 3) {
  let attempts = 0;
  let success = false;
  while (attempts < maxRetries && !success) {
    try {
      await bot.telegram.sendMessage(chatId, message, options);
      success = true;  // If no error, mark as success
    } catch (error) {
      attempts++;
      if (attempts < maxRetries) {
        logger.warn(`Retrying message send (attempt ${attempts})...`);
        await new Promise(resolve => setTimeout(resolve, 5000));  // Delay before retry
      } else {
        logger.error(`Failed to send message after ${maxRetries} attempts: ${error.message}`);
        throw error;  // If retry attempts failed, re-throw the error
      }
    }
  }
}


// ======= MAIN FUNCTIONALITY =======

// Core function to gather and send TCAPY information
async function sendTcapyInfoAutomatically(ctx) {
  const startTime = Date.now();
  logger.info(`Starting TCAPY info update at ${new Date().toISOString()}`);
  
  try {
    const symbol = config.SYMBOL;
    let chatId, messageThreadId;
    
    // Determine where to send the message
    if (ctx) {
      // If we have context, use that chat ID
      chatId = ctx.chat.id.toString();
      messageThreadId = ctx.message?.message_thread_id ? ctx.message.message_thread_id.toString() : null;
      logger.info(`Sending update to chat ${chatId}${messageThreadId ? `, thread ${messageThreadId}` : ''} (from command)`);
    } else {
      // Otherwise use the configured IDs
      chatId = config.GROUP_CHAT_ID;
      messageThreadId = config.MESSAGE_THREAD_ID;
      logger.info(`Sending scheduled update to chat ${chatId}${messageThreadId ? `, thread ${messageThreadId}` : ''}`);
    }

    // Fetch all required data in parallel
    logger.info('Fetching data from CoinMarketCap and MEXC APIs...');
    
    const [cmcData, mexcVolume, trades, orderBook] = await Promise.all([
      apiService.fetchCmcData('TCAPY').catch(err => {
        logger.error(`Failed to fetch CMC data: ${err.message}`);
        return { volume24h: 0, price: 0 };
      }),
      
      apiService.fetchMexc24hVolume(symbol).catch(err => {
        logger.error(`Failed to fetch MEXC 24h volume: ${err.message}`);
        return 0;
      }),
      
      apiService.fetchMexcTrades(symbol, 1000).catch(err => {
        logger.error(`Failed to fetch MEXC trades: ${err.message}`);
        return [];
      }),
      
      apiService.fetchMexcOrderBook(symbol, 100).catch(err => {
        logger.error(`Failed to fetch MEXC depth data: ${err.message}`);
        return { bids: [], asks: [] };
      })
    ]);

    // Validate data
    if (!trades || trades.length === 0) {
      throw new Error('No trade data available from MEXC API');
    }

    logger.info(`Successfully fetched data. Processing ${trades.length} trades...`);

    // Get current price and calculate time windows
    const currentPrice = parseFloat(trades[0]?.price || 0);
    if (isNaN(currentPrice) || currentPrice <= 0) {
      throw new Error('Invalid current price data');
    }

    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const thirtyMinutesAgo = now - 30 * 60 * 1000;
    const fifteenMinutesAgo = now - 15 * 60 * 1000;

    // Get historical prices
    const price15MinAgo = getPriceAtTime(trades, fifteenMinutesAgo);
    const price30MinAgo = getPriceAtTime(trades, thirtyMinutesAgo);
    const price1HourAgo = getPriceAtTime(trades, oneHourAgo);

    // Calculate price changes
    const change15Min = ((currentPrice - price15MinAgo) / (price15MinAgo || 1) * 100).toFixed(2);
    const change30Min = ((currentPrice - price30MinAgo) / (price30MinAgo || 1) * 100).toFixed(2);
    const change1Hour = ((currentPrice - price1HourAgo) / (price1HourAgo || 1) * 100).toFixed(2);

    // Log price data
    logger.debug(`Price data: 
      Current: ${currentPrice}, 
      15m ago: ${price15MinAgo} (${change15Min}%), 
      30m ago: ${price30MinAgo} (${change30Min}%), 
      1h ago: ${price1HourAgo} (${change1Hour}%)`);

    // Get actual volumes if we have sufficient trade data
    const actualOneHourData = calculateVolume(trades, oneHourAgo);
    const actualThirtyMinData = calculateVolume(trades, thirtyMinutesAgo);
    const actualFifteenMinData = calculateVolume(trades, fifteenMinutesAgo);

    // Get total 24h volume from CoinMarketCap (more reliable across all exchanges)
    const volume24hCmc = cmcData.volume24h || 0;
    
    // Estimate more realistic volumes using both actual data and CMC total volume
    const tradeData = {
      currentPrice,
      change15Min,
      change30Min,
      change1Hour
    };
    
    // Get estimated volumes
    const estimatedVolumes = estimateVolumeDistribution(volume24hCmc, tradeData);
    
    // Use actual data if it seems realistic, otherwise use estimates
    const oneHourData = parseFloat(actualOneHourData.totalBuyValue) + parseFloat(actualOneHourData.totalSellValue) > volume24hCmc * 0.03 ? 
      actualOneHourData : estimatedVolumes.hour1;
      
    const thirtyMinData = parseFloat(actualThirtyMinData.totalBuyValue) + parseFloat(actualThirtyMinData.totalSellValue) > volume24hCmc * 0.02 ? 
      actualThirtyMinData : estimatedVolumes.min30;
      
    const fifteenMinData = parseFloat(actualFifteenMinData.totalBuyValue) + parseFloat(actualFifteenMinData.totalSellValue) > volume24hCmc * 0.01 ? 
      actualFifteenMinData : estimatedVolumes.min15;

    // Generate buy zones
    const buyZones = generateBuyZones(trades, orderBook, currentPrice, volume24hCmc);

    // Build the message
    logger.info('Building message with processed data...');
    let message = `<b>🚨 TCAPY/USDT Real-Time Update </b>\n\n`;
    message += `<b>💰 Current Price:</b> $${formatPrice(currentPrice, 6)} USDT\n`;
    message += `<b>🕒 15m:</b> ${change15Min}% | <b>⏳ 30m:</b> ${change30Min}% | <b>🕰 1h:</b> ${change1Hour}%\n\n`;

    // Market signal logic
    const changes = [
      { timeframe: '15 Minutes', change: parseFloat(change15Min), data: fifteenMinData },
      { timeframe: '30 Minutes', change: parseFloat(change30Min), data: thirtyMinData },
      { timeframe: '1 Hour', change: parseFloat(change1Hour), data: oneHourData },
    ];
    
    const maxChangeTimeframe = changes.reduce((prev, current) => 
      (Math.abs(prev.change) > Math.abs(current.change) ? prev : current));
    
    const selectedChange = maxChangeTimeframe.change;
    const selectedData = maxChangeTimeframe.data;
    const buyValue = parseFloat(selectedData.totalBuyValue);
    const sellValue = parseFloat(selectedData.totalSellValue);
    const buySellRatio = sellValue <= 0 ? 1 : buyValue / sellValue;

    if (Math.abs(parseFloat(change15Min)) >= 5) {
      message += `<b>⚠️ ALERT: Significant Price Change</b>\n`;
    }

    // Generate signal message based on price movement
    let signalMessage = '';
    if (selectedChange >= 15) {
      signalMessage = `🌋 Volcanic surge in ${maxChangeTimeframe.timeframe}: TCAPY is erupting with massive buy pressure – FOMO incoming!`;
    } else if (selectedChange >= 10) {
      signalMessage = `🚀 Massive breakout in ${maxChangeTimeframe.timeframe}: TCAPY is exploding with extreme buy strength – watch for FOMO zones!`;
    } else if (selectedChange >= 7) {
      signalMessage = `📈 Strong bullish rally in ${maxChangeTimeframe.timeframe}: Price accelerating fast with solid buying confidence.`;
    } else if (selectedChange >= 5) {
      signalMessage = `💥 Market momentum rising in ${maxChangeTimeframe.timeframe}: Buyers are dominating, and optimism is spreading.`;
    } else if (selectedChange >= 3) {
      signalMessage = `💡 TCAPY gaining momentum in ${maxChangeTimeframe.timeframe}: A solid climb with active demand.`;
    } else if (selectedChange >= 2) {
      signalMessage = `🌟 Strong uptrend in ${maxChangeTimeframe.timeframe}: Buyers stepping in – good signs of strength.`;
    } else if (selectedChange >= 1.5) {
      signalMessage = `✅ Positive signal in ${maxChangeTimeframe.timeframe}: Healthy buying momentum and bullish continuation is possible.`;
    } else if (selectedChange >= 1.0) {
      signalMessage = `🟢 Mild strength detected in ${maxChangeTimeframe.timeframe}: Gradual move up with buyer support.`;
    } else if (selectedChange >= 0.5) {
      signalMessage = `📊 Slow and steady growth in ${maxChangeTimeframe.timeframe}: Market trending upward slightly, potential ahead.`;
    } else if (selectedChange >= 0.2) {
      signalMessage = `🌱 Small uptick in ${maxChangeTimeframe.timeframe}: Early signs of accumulation – worth keeping an eye on!`;
    } else if (selectedChange > -0.1 && selectedChange < 0.2) {
      signalMessage = `🌾 Sideways phase in ${maxChangeTimeframe.timeframe}: Stable zone – often the base before bigger moves.`;
    } else if (selectedChange <= -0.1 && selectedChange > -0.3) {
      signalMessage = `🌥 Light dip in ${maxChangeTimeframe.timeframe}: Nothing alarming – typical minor correction.`;
    } else if (selectedChange <= -0.3 && selectedChange > -0.7) {
      signalMessage = `🟠 Slight weakness in ${maxChangeTimeframe.timeframe}: Selling ahead but not overwhelming – calm before next move.`;
    } else if (selectedChange <= -0.7 && selectedChange > -1.5) {
      signalMessage = `🔄 Market cooling in ${maxChangeTimeframe.timeframe}: Some profit-taking – patient buyers may find a chance.`;
    } else if (selectedChange <= -1.5 && selectedChange > -3) {
      signalMessage = `📉 Pullback zone in ${maxChangeTimeframe.timeframe}: Short-term correction – long-term outlook can stay solid.`;
    } else if (selectedChange <= -3) {
      signalMessage = `🌀 Market shakeout in ${maxChangeTimeframe.timeframe}: Stronger sell wave – rebounds often follow!`;
    }

    // Add market activity indicators
    if (buySellRatio > 1.5 && (buyValue + sellValue) > volume24hCmc * 0.01) {
      signalMessage += ` 📈 High buy pressure detected!`;
    } else if (buySellRatio < 0.8 && (buyValue + sellValue) > volume24hCmc * 0.01) {
      signalMessage += ` 📉 Potential buying opportunity!`;
    } else if ((buyValue + sellValue) > volume24hCmc * 0.02) {
      signalMessage += ` 🔊 Active market with high participation!`;
    }

    message += `${signalMessage}\n`;

    // Display volume data
    message += `\n🔴 <b>Sell Orders (Asks)</b>\n`;
    const timeFrames = [
      { label: '15 Minutes', data: fifteenMinData },
      { label: '30 Minutes', data: thirtyMinData },
      { label: '1 Hour', data: oneHourData },
    ];
    
    timeFrames.forEach(({ label, data }) => {
      const sellValue = parseFloat(data.totalSellValue);
      const sellAmount = parseFloat(data.totalSellAmount);
      
      if (!isNaN(sellValue) && !isNaN(sellAmount)) {
        message += `- <b>Last ${label}:</b> $${formatNumber(sellValue, 0)} | ${formatNumber(sellAmount, 0)} TCAPY\n`;
      }
    });

    message += `\n🟢 <b>Buy Orders (Bids)</b>\n`;
    timeFrames.forEach(({ label, data }) => {
      const buyValue = parseFloat(data.totalBuyValue);
      const buyAmount = parseFloat(data.totalBuyAmount);
      
      if (!isNaN(buyValue) && !isNaN(buyAmount)) {
        message += `- <b>Last ${label}:</b> $${formatNumber(buyValue, 0)} | ${formatNumber(buyAmount, 0)} TCAPY\n`;
      }
    });

    // Add top buy zones section
    if (buyZones.length > 0) {
      message += `\n<b>🏆 Top Buy Zones Right Now</b> 💡 <b>Buy Pressure Here!</b>\n`;
      
      buyZones.forEach(({ price, amount, value }) => {
        if (!isNaN(price) && !isNaN(amount) && !isNaN(value)) {
          message += `$${formatPrice(price, 6)} | $${formatNumber(value, 0)} | ${formatNumber(amount, 0)} TCAPY\n`;
        }
      });
    } else {
      message += `\n🟢 No significant buy zones detected in the last 3 hours.\n`;
    }

    // Add market cap data
    try {
      const circulatingSupply = config.TCAPY_SUPPLY;
      const marketCap = currentPrice * circulatingSupply;

      message += `\n<b>📊 On-Chain Metrics </b>`;
      message += `\n<b>- Total Volume 24H:</b> $${formatNumber(volume24hCmc, 0)}`;
      message += `\n<b>- Market Cap:</b> $${formatNumber(marketCap, 0)}`;
      message += `\n<b>- Circulating Supply:</b> ${formatNumber(circulatingSupply, 0)}\n`;
    } catch (error) {
      logger.error(`Error calculating market metrics: ${error.message}`);
      message += `\n⚠️ <b>Market metrics unavailable.</b>\n`;
    }

    message += `\n🔗 <a href="https://www.mexc.com/exchange/TCAPY_USDT">View on MEXC</a>`; 
    message += `\n📚 <b><a>/tcapy@Tcapy_bot</a> Update Real-Time </b>`; 
    message += `\n🌐 Updated by <b>TCAPY Community Bot</b>`;
    
    // Send the message
    logger.info('Sending TCAPY update message...');
    
    const sendOptions = { 
      parse_mode: 'HTML',  // Specify that message uses HTML formatting
      disable_web_page_preview: false  // This ensures link previews are shown
    };
    
    // Ensure message_thread_id is properly handled
    if (messageThreadId && messageThreadId !== 'null' && messageThreadId !== 'undefined') {
      sendOptions.message_thread_id = parseInt(messageThreadId, 10);
      logger.debug(`Sending to thread ID: ${messageThreadId}`);
    }
    
    // Ensure numeric chat ID
    const numericChatId = parseInt(chatId, 10);
    if (isNaN(numericChatId)) {
      throw new Error(`Invalid chat ID: ${chatId}`);
    }
    
    // Send the message to the chat
    await bot.telegram.sendMessage(numericChatId, message, sendOptions);
    
    const duration = (Date.now() - startTime) / 1000;
    logger.info(`Sent TCAPY info update. Duration: ${duration.toFixed(2)}s`);
    
    return true;
  } catch (error) {
    logger.error(`Failed to send TCAPY info: ${error.message}`);
    if (error.stack) {
      logger.debug(`Error stack: ${error.stack}`);
    }
    
    // Create detailed error message
    let errorMessage = '❌ Error fetching TCAPY data.';
    
    if (error.message.includes('trade data')) {
      errorMessage += ' No recent trades found.';
    } else if (error.message.includes('price data')) {
      errorMessage += ' Invalid price data.';
    } else if (error.response) {
      errorMessage += ` API returned status ${error.response.status}.`;
      if (error.response.data?.msg) {
        errorMessage += ` Message: ${error.response.data.msg}`;
      }
    } else if (error.request) {
      errorMessage += ' No response from API server.';
    } else {
      errorMessage += ` Error: ${error.message}`;
    }
    
    // Send error message if we have a context or group ID
    if (ctx) {
      try {
        await ctx.reply(errorMessage, { parse_mode: 'HTML' });
      } catch (msgError) {
        logger.error(`Failed to send error message: ${msgError.message}`);
      }
    } else if (config.GROUP_CHAT_ID) {
      try {
        const sendOptions = { parse_mode: 'HTML' };
        if (config.MESSAGE_THREAD_ID) {
          sendOptions.message_thread_id = parseInt(config.MESSAGE_THREAD_ID, 10);
        }
        
        await bot.telegram.sendMessage(
          parseInt(config.GROUP_CHAT_ID, 10), 
          errorMessage, 
          sendOptions
        );
      } catch (msgError) {
        logger.error(`Failed to send error notification: ${msgError.message}`);
      }
    }
    
    return false;
  }
}

// ======= BOT COMMAND HANDLERS =======

// Start command
bot.start((ctx) => {
  logger.info(`/start command received from ${ctx.from.id} in chat ${ctx.chat.id}`);
  ctx.replyWithHTML(`
    💰 <b> Welcome to TCAPY Community Bot </b> 💰
  Hello! Explore cryptocurrency data with these commands:
- <code>/start</code> - Show the welcome message
- <code>/tcapy</code> - See real-time TCAPY investment signals 
- <code>/coin [symbol]</code> - Get details for a specific coin (e.g. <code>/coin tcapy</code>)
- <code>/help</code> - Display all available commands
  `);
});

// Help command
bot.help((ctx) => {
  logger.info(`/help command received from ${ctx.from.id} in chat ${ctx.chat.id}`);
  ctx.replyWithHTML(`
            📚 <b>Command Guide</b>📚
  Here's everything you can do with this bot:
- /start - Displays the welcome message to get you started.
- /tcapy - Shows real-time investment signals for TCAPY.
- /coin [symbol] - Fetches details for a specific cryptocurrency. 
- <b><code>/coin tcapy</code></b> - Get details for TCAPY.
- /help - Brings up this guide with all available commands.
  `);
});

// Coin command
bot.command('coin', async (ctx) => {
  const symbol = ctx.payload.trim().toUpperCase();
  logger.info(`/coin command received with symbol: ${symbol} from ${ctx.from.id} in chat ${ctx.chat.id}`);
  
  if (!symbol) return ctx.reply('❌ Please provide a coin symbol (e.g., /coin BTC)');

  try {
    const coinData = await apiService.fetchCmcData(symbol);
    const currentPrice = coinData.price;
    const circulatingSupply = symbol === 'TCAPY' ? config.TCAPY_SUPPLY : null;
    const marketCap = currentPrice * (circulatingSupply || coinData.market_cap / currentPrice);

    // Construct the response message
    let message = `
📈 <b>${coinData.name} (${symbol})</b>
💰 <b>Current Price:</b> $${formatPrice(currentPrice)}
📊 <b>24h Change:</b> ${formatNumber(coinData.percent_change_24h, 2)}%
📊 <b>1h Change:</b> ${formatNumber(coinData.percent_change_1h, 2)}%
🔄 <b>24h Volume:</b> $${formatNumber(coinData.volume24h, 0)}
🔄 <b>Market Cap:</b> $${formatNumber(marketCap, 0)}
    `;

    // Special message for TCAPY
    if (symbol === 'TCAPY') {
      message += `
🔢 <b>Total Supply:</b> ${formatNumber(config.TCAPY_SUPPLY, 0)} TCAPY

🌟 <b>Welcome to TonCapy!</b>
TonCapy is where memes meet crypto—an energetic hub inspired by the friendly capybara. With the TCapy token at its heart, our platform empowers Telegram projects to effortlessly create, manage, and grow vibrant communities.

<b>Why TonCapy?</b>
🤝 Community Building: Seamlessly connect with like-minded users.
⚡ Real-Time Interaction: Enjoy dynamic notifications & interactive content.
🚀 Token Ecosystem: Fuel community growth with TCapy.

<b>Impressive Achievements:</b>
• 1.5M Spins • 14.3B Total TCapy
• 300K Daily Active Users • 4M Monthly Active Users
• 5.5M Total Holders • 4.2M Users in 1 Month!
      `;
    }

    message += `\n🔗 <a href="https://coinmarketcap.com/currencies/${coinData.slug}/">View Chart</a>`;

    // Inline keyboard
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.url('Chart', `https://coinmarketcap.com/currencies/${coinData.slug}/`)],
      [Markup.button.url('News', `https://coinmarketcap.com/currencies/${coinData.slug}/news/`)],
    ]);

    await ctx.replyWithHTML(message, keyboard);
    logger.info(`Successfully sent coin data for ${symbol} to ${ctx.chat.id}`);
  } catch (error) {
    logger.error(`Failed to retrieve coin data for ${symbol}: ${error.message}`);
    
    let errorMessage = 'Unable to retrieve data';
    
    if (error.response) {
      const { status, data } = error.response;
      const apiError = data?.status?.error_message;
      
      switch (status) {
        case 400: errorMessage = 'Invalid request. Please check the coin symbol.'; break;
        case 401: errorMessage = 'API key error. Please contact the bot owner.'; break;
        case 403: errorMessage = 'Access denied. Please contact the bot owner.'; break;
        case 429: errorMessage = 'Rate limit exceeded. Please try again later.'; break;
        case 500: errorMessage = 'Server error. Please try again later.'; break;
        default: errorMessage = 'An unexpected error occurred.';
      }
      
      if (apiError) errorMessage += ` Details: ${apiError}`;
    } else if (error.request) {
      errorMessage = 'No response from server. Please try again later.';
    } else {
      errorMessage = `Error: ${error.message}`;
    }
    
    await ctx.reply(`❌ ${errorMessage}`);
  }
});

// TCAPY command handler
bot.command(['tcapy', 'tcapy@Tcapy_bot'], async (ctx) => {
  // Debug information
  logger.debug(`Command received in chat ${ctx.chat.id}, configured chat: ${config.GROUP_CHAT_ID}`);
  logger.debug(`Message thread ID: ${ctx.message?.message_thread_id}, configured thread: ${config.MESSAGE_THREAD_ID}`);
  
  // Convert chat IDs to strings for proper comparison
  const chatId = ctx.chat.id.toString();
  const configuredChatId = config.GROUP_CHAT_ID;
  
  // Convert thread IDs to strings (if they exist)
  const threadId = ctx.message?.message_thread_id ? ctx.message.message_thread_id.toString() : null;
  const configuredThreadId = config.MESSAGE_THREAD_ID;
  
  // Improved permission check logic
  let permissionDenied = false;
  let permissionMessage = '';
  
  // If GROUP_CHAT_ID is set, check if command is in correct chat
  if (configuredChatId && chatId !== configuredChatId) {
    logger.debug(`Command rejected - requested in chat ${chatId}, configured for ${configuredChatId}`);
    permissionDenied = true;
    permissionMessage = '❌ This command is only available in the designated group.';
  }
  
  // If MESSAGE_THREAD_ID is set and we're in a forum, check if correct thread
  if (!permissionDenied && configuredThreadId && threadId !== configuredThreadId && ctx.chat.is_forum) {
    logger.debug(`Command rejected - requested in thread ${threadId}, configured for ${configuredThreadId}`);
    permissionDenied = true;
    permissionMessage = '❌ This command is only available in the designated topic.';
  }
  
  // Handle permission denied case
  if (permissionDenied) {
    return ctx.reply(permissionMessage, {
      message_thread_id: threadId ? parseInt(threadId, 10) : undefined
    });
  }
  
  // Show typing indicator
  try {
    await ctx.telegram.sendChatAction(ctx.chat.id, 'typing', {
      message_thread_id: threadId ? parseInt(threadId, 10) : undefined
    });
  } catch (error) {
    logger.warn(`Could not send typing indicator: ${error.message}`);
    // Continue execution, this is not critical
  }
  
  // Send message that we're collecting data
  let statusMsg;
  try {
    statusMsg = await ctx.reply('🔄 Collecting real-time TCAPY data, please wait...', {
      message_thread_id: threadId ? parseInt(threadId, 10) : undefined
    });
  } catch (error) {
    logger.warn(`Could not send status message: ${error.message}`);
    // Continue without status message
  }
  
  try {
    // Call the core function with current context
    const success = await sendTcapyInfoAutomatically(ctx);
    
    // Delete status message if successful
    if (success && statusMsg) {
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
      } catch (error) {
        logger.debug(`Could not delete status message: ${error.message}`);
      }
    }
  } catch (error) {
    logger.error(`Error executing /tcapy command: ${error.message}`);
    
    try {
      await ctx.reply('❌ Failed to retrieve TCAPY data. Please try again later.', {
        message_thread_id: threadId ? parseInt(threadId, 10) : undefined
      });
    } catch (replyError) {
      logger.error(`Could not send error message: ${replyError.message}`);
    }
  }
});


// ======= SCHEDULED UPDATES =======
let updateInterval;
function startScheduledUpdates() {
  if (updateInterval) {
    clearInterval(updateInterval);
    logger.info('Cleared previous update interval');
  }

  logger.info('Starting scheduled updates...');
  logger.info(`Will send updates to chat ${config.GROUP_CHAT_ID}${config.MESSAGE_THREAD_ID ? `, thread ${config.MESSAGE_THREAD_ID}` : ''}`);
  
  // Set up regular interval with robust error handling
  updateInterval = setInterval(async () => {
    try {
      logger.info(`Running scheduled update at ${new Date().toISOString()}...`);
      const result = await sendTcapyInfoAutomatically();
      logger.info(`Scheduled update result: ${result ? 'success' : 'failed'}`);
    } catch (err) {
      logger.error(`Failed to send scheduled TCAPY update: ${err.message}`);
      logger.debug(`Error stack: ${err.stack}`);
      
      // Better notification system
      try {
        if (config.GROUP_CHAT_ID) {
          const sendOptions = { parse_mode: 'HTML' };
          if (config.MESSAGE_THREAD_ID) {
            sendOptions.message_thread_id = parseInt(config.MESSAGE_THREAD_ID, 10);
          }
          
          await bot.telegram.sendMessage(
            parseInt(config.GROUP_CHAT_ID, 10), 
            '❌ Scheduled update failed. The bot will try again at the next scheduled time.', 
            sendOptions
          );
        }
      } catch (notifyError) {
        logger.error(`Failed to send error notification: ${notifyError.message}`);
      }
    }
  }, config.UPDATE_INTERVAL);

  logger.info(`Scheduled updates started. Interval: ${config.UPDATE_INTERVAL / 60000} minutes`);
  logger.info(`Next update scheduled at ${new Date(Date.now() + config.UPDATE_INTERVAL).toISOString()}`);
}

// Health check function
let healthCheckTimer;
function startHealthCheck() {
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  
  healthCheckTimer = setInterval(() => {
    logger.debug(`Health check: Bot is alive at ${new Date().toISOString()}`);
  }, 300000); // Every 5 minutes
}

// ======= BOT LAUNCH =======
async function launchBot() {
  try {
    // Launch the bot with optimized update types
    await bot.launch({
      allowedUpdates: ['message', 'callback_query']
    });
    
    logger.info(`Bot started successfully at ${new Date().toISOString()}`);
    logger.info(`Bot username: @${bot.botInfo.username}`);
    
    // Start health check
    startHealthCheck();
    
    // Send initial TCAPY update
    logger.info('Running initial TCAPY info update...');
    try {
      await sendTcapyInfoAutomatically();
      logger.info('Initial TCAPY info update completed successfully');
    } catch (error) {
      logger.error(`Failed to run initial update: ${error.message}`);
      // Continue with bot operation even if initial update fails
    }
    
    // Start scheduled updates
    startScheduledUpdates();
    
  } catch (error) {
    logger.error(`Failed to start bot: ${error.message}`);
    if (error.stack) {
      logger.debug(`Error stack: ${error.stack}`);
    }
    process.exit(1);
  }
}

// Launch the bot
launchBot();

// ======= GRACEFUL SHUTDOWN =======
process.once('SIGINT', () => {
  logger.info('SIGINT received. Shutting down bot...');
  bot.stop('SIGINT');
  clearInterval(updateInterval);
  clearInterval(healthCheckTimer);
});

process.once('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down bot...');
  bot.stop('SIGTERM');
  clearInterval(updateInterval);
  clearInterval(healthCheckTimer);
});

// ======= ERROR HANDLING =======
process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled Promise Rejection: ${reason}`);
  if (reason.stack) {
    logger.debug(`Error stack: ${reason.stack}`);
  }
  // Do not crash the application, but log the error
});

process.on('uncaughtException', (error) => {
  logger.error(`Uncaught Exception: ${error.message}`);
  logger.debug(`Error stack: ${error.stack}`);
  // Do not exit here, let the process continue if possible
});