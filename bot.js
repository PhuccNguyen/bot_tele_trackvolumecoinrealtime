import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { createLogger, format, transports } from 'winston';

// Fix path for .env in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '.env') });

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

// Setup logger
const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    format.errors({ stack: true }),
    format.splat(),
    format.json()
  ),
  defaultMeta: { service: 'tcapy-bot' },
  transports: [
    new transports.File({ filename: path.join(logsDir, 'error.log'), level: 'error' }),
    new transports.File({ filename: path.join(logsDir, 'combined.log') }),
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.simple()
      )
    })
  ]
});

// Validate required environment variables
const requiredEnvVars = [
  'BOT_TOKEN',
  'CMC_API_KEY',
  'MEXC_API_KEY',
  'MEXC_API_SECRET',
  'GROUP_CHAT_ID'
];

const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
if (missingEnvVars.length > 0) {
  logger.error(`Missing required environment variables: ${missingEnvVars.join(', ')}`);
  process.exit(1);
}

logger.info('Environment variables loaded successfully');

// Initialize bot and API keys
const bot = new Telegraf(process.env.BOT_TOKEN);
const CMC_API_KEY = process.env.CMC_API_KEY;
const MEXC_API_KEY = process.env.MEXC_API_KEY;
const MEXC_API_SECRET = process.env.MEXC_API_SECRET;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
const MESSAGE_THREAD_ID = process.env.MESSAGE_THREAD_ID;

// Create axios instances with default configs
const cmcAxios = axios.create({
  baseURL: 'https://pro-api.coinmarketcap.com/v2',
  headers: {
    'X-CMC_PRO_API_KEY': CMC_API_KEY,
    'Accept-Encoding': 'gzip'
  },
  timeout: 10000
});

const mexcAxios = axios.create({
  baseURL: 'https://api.mexc.com/api/v3',
  timeout: 10000
});

// =====================================================
// Helper Functions
// =====================================================

// Format price with appropriate decimal places
function formatPrice(price) {
  if (typeof price !== 'number' || isNaN(price)) return 'N/A';
  
  if (price < 0.0001) {
    return price.toFixed(8).replace(/\.?0+$/, '');
  } else if (price < 0.01) {
    return price.toFixed(6).replace(/\.?0+$/, '');
  } else if (price < 1) {
    return price.toFixed(4).replace(/\.?0+$/, '');
  } else {
    return price.toFixed(2).replace(/\.?0+$/, '');
  }
}

// Format number with localized thousands separators
function formatNumber(num, decimals = 2) {
  if (typeof num !== 'number' || isNaN(num)) return 'N/A';
  
  return num.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// Create HMAC signature for MEXC API
function createSignature(queryString) {
  return crypto.createHmac('sha256', MEXC_API_SECRET)
    .update(queryString)
    .digest('hex');
}

// Generate a throttled function to prevent API rate limits
function throttle(func, delay) {
  let lastCall = 0;
  let timeout;
  
  return function(...args) {
    const now = Date.now();
    const timeSinceLastCall = now - lastCall;
    
    if (timeSinceLastCall >= delay) {
      lastCall = now;
      return func.apply(this, args);
    } else {
      clearTimeout(timeout);
      return new Promise(resolve => {
        timeout = setTimeout(() => {
          lastCall = Date.now();
          resolve(func.apply(this, args));
        }, delay - timeSinceLastCall);
      });
    }
  };
}

// Retry function for API calls
async function withRetry(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      
      logger.warn(`API call failed, retrying (${i + 1}/${retries}): ${error.message}`);
      
      // Exponential backoff
      await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
    }
  }
}

// =====================================================
// API Functions
// =====================================================

// Fetch data from CoinMarketCap API with retry
async function fetchCmcData(symbol) {
  try {
    return await withRetry(async () => {
      const response = await cmcAxios.get('/cryptocurrency/quotes/latest', {
        params: { symbol, convert: 'USDT' }
      });
      
      const coinData = response.data.data[symbol]?.[0];
      if (!coinData) {
        throw new Error(`Coin data not found for symbol: ${symbol}`);
      }
      
      return {
        name: coinData.name,
        slug: coinData.slug,
        price: coinData.quote.USDT.price || 0,
        volume24h: coinData.quote.USDT.volume_24h || 0,
        percent_change_1h: coinData.quote.USDT.percent_change_1h || 0,
        percent_change_24h: coinData.quote.USDT.percent_change_24h || 0,
        market_cap: coinData.quote.USDT.market_cap || 0,
        circulating_supply: coinData.circulating_supply || 0,
        total_supply: coinData.total_supply || 0,
        max_supply: coinData.max_supply || 0
      };
    });
  } catch (error) {
    logger.error('Failed to fetch CMC data', { symbol, error: error.message });
    throw error;
  }
}

// Throttled version to respect rate limits
const throttledFetchCmcData = throttle(fetchCmcData, 2000);

// Fetch MEXC 24h trading volume
async function fetchMexc24hVolume(symbol) {
  try {
    return await withRetry(async () => {
      const response = await mexcAxios.get('/ticker/24hr', {
        params: { symbol }
      });
      
      const quoteVolume = parseFloat(response.data.quoteVolume) || 0;
      logger.info(`MEXC 24h volume for ${symbol}: ${quoteVolume} USDT`);
      
      return quoteVolume;
    });
  } catch (error) {
    logger.error('Failed to fetch MEXC 24h volume', { 
      symbol, 
      error: error.message,
      stack: error.stack
    });
    
    return 0;
  }
}

// Fetch trade history from MEXC with error handling
async function fetchTradeHistory(symbol, limit = 1000) {
  try {
    return await withRetry(async () => {
      const timestamp = Date.now();
      const queryString = `symbol=${symbol}&limit=${limit}&timestamp=${timestamp}`;
      const signature = createSignature(queryString);
      
      const response = await mexcAxios.get('/trades', {
        params: { 
          symbol, 
          limit,
          timestamp,
          signature 
        },
        headers: { 
          'X-MEXC-APIKEY': MEXC_API_KEY 
        }
      });
      
      if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
        throw new Error('No trade data available');
      }
      
      return response.data;
    });
  } catch (error) {
    logger.error('Failed to fetch trade history', { 
      symbol, 
      error: error.message 
    });
    
    throw error;
  }
}

// Fetch order book from MEXC with error handling
async function fetchOrderBook(symbol, limit = 100) {
  try {
    return await withRetry(async () => {
      const response = await mexcAxios.get('/depth', {
        params: { symbol, limit }
      });
      
      return response.data;
    });
  } catch (error) {
    logger.error('Failed to fetch order book', { 
      symbol, 
      error: error.message 
    });
    
    return { bids: [], asks: [] };
  }
}

// =====================================================
// Trading Analysis Functions
// =====================================================

// Calculate buy and sell volumes from trade history
function calculateVolume(trades, startTime) {
  if (!trades || !Array.isArray(trades) || trades.length === 0) {
    logger.warn("Empty trades array or invalid data in calculateVolume");
    return {
      totalSellValue: 0,
      totalSellAmount: 0,
      totalBuyValue: 0,
      totalBuyAmount: 0,
    };
  }

  let totalSellValue = 0;
  let totalSellAmount = 0;
  let totalBuyValue = 0;
  let totalBuyAmount = 0;

  trades.forEach(trade => {
    if (!trade || !trade.time || !trade.price || !trade.qty) return;
    
    const tradeTime = parseInt(trade.time, 10);
    if (isNaN(tradeTime) || tradeTime < startTime) return;
    
    const price = parseFloat(trade.price);
    const qty = parseFloat(trade.qty);
    if (isNaN(price) || isNaN(qty)) return;
    
    const value = price * qty;
    
    if (trade.isBuyerMaker) {
      totalSellValue += value;
      totalSellAmount += qty;
    } else {
      totalBuyValue += value;
      totalBuyAmount += qty;
    }
  });

  return {
    totalSellValue,
    totalSellAmount,
    totalBuyValue,
    totalBuyAmount,
  };
}

// Cải thiện ước tính khối lượng giao dịch
function estimateVolumeDistribution(totalVolume24h, tradeData) {
  // Phân bổ tỷ lệ cao hơn cho các khoảng thời gian ngắn hơn
  const hour1Percent = tradeData.change1Hour > 0 ? 0.1 : 0.08;
  const min30Percent = tradeData.change30Min > 0 ? 0.06 : 0.05;
  const min15Percent = tradeData.change15Min > 0 ? 0.04 : 0.03;

  // Tính tỷ lệ mua/bán dựa trên biến động giá
  const calculateBuyRatio = (change) => {
    if (change > 2) return 0.8; // Tăng mạnh: 80% là mua
    if (change > 1) return 0.7; // Tăng vừa: 70% là mua
    if (change > 0.2) return 0.6; // Tăng nhẹ: 60% là mua
    if (change > -0.2) return 0.5; // Đi ngang: 50-50
    if (change > -1) return 0.4; // Giảm nhẹ: 40% là mua
    if (change > -2) return 0.3; // Giảm vừa: 30% là mua
    return 0.2; // Giảm mạnh: 20% là mua
  };

  // Tính các tỷ lệ
  const buyRatio1h = calculateBuyRatio(tradeData.change1Hour);
  const buyRatio30m = calculateBuyRatio(tradeData.change30Min);
  const buyRatio15m = calculateBuyRatio(tradeData.change15Min);

  // Tính khối lượng
  const volume1h = totalVolume24h * hour1Percent;
  const volume30m = totalVolume24h * min30Percent;
  const volume15m = totalVolume24h * min15Percent;

  return {
    hour1: {
      totalBuyValue: volume1h * buyRatio1h,
      totalSellValue: volume1h * (1 - buyRatio1h),
      totalBuyAmount: Math.round((volume1h * buyRatio1h) / tradeData.currentPrice),
      totalSellAmount: Math.round((volume1h * (1 - buyRatio1h)) / tradeData.currentPrice)
    },
    min30: {
      totalBuyValue: volume30m * buyRatio30m,
      totalSellValue: volume30m * (1 - buyRatio30m),
      totalBuyAmount: Math.round((volume30m * buyRatio30m) / tradeData.currentPrice),
      totalSellAmount: Math.round((volume30m * (1 - buyRatio30m)) / tradeData.currentPrice)
    },
    min15: {
      totalBuyValue: volume15m * buyRatio15m,
      totalSellValue: volume15m * (1 - buyRatio15m),
      totalBuyAmount: Math.round((volume15m * buyRatio15m) / tradeData.currentPrice),
      totalSellAmount: Math.round((volume15m * (1 - buyRatio15m)) / tradeData.currentPrice)
    }
  };
}

// Find price at a specific time from trades
function getPriceAtTime(trades, targetTime) {
  if (!trades || trades.length === 0) {
    return null;
  }
  
  // Filter trades that are before the target time
  const validTrades = trades.filter(trade => parseInt(trade.time) <= targetTime);
  
  if (validTrades.length === 0) {
    return parseFloat(trades[trades.length - 1].price);
  }
  
  // Find the closest trade
  const closestTrade = validTrades.reduce((prev, curr) => {
    const prevDiff = Math.abs(parseInt(prev.time) - targetTime);
    const currDiff = Math.abs(parseInt(curr.time) - targetTime);
    return currDiff < prevDiff ? curr : prev;
  });
  
  return parseFloat(closestTrade.price);
}

// Generate buy zones with highest price and volume - Improved version
function generateBuyZones(trades, orderBook, currentPrice, volume24h) {
  // Tạo các vùng mua mặc định gần với giá hiện tại
  const defaultBuyZones = [
    { 
      price: currentPrice * 0.99, // Giảm 1% so với giá hiện tại
      amount: Math.round(volume24h * 0.07 / currentPrice),
      value: volume24h * 0.07
    },
    { 
      price: currentPrice * 0.97, // Giảm 3% so với giá hiện tại
      amount: Math.round(volume24h * 0.1 / currentPrice),
      value: volume24h * 0.1
    }
  ];

  // Nếu có dữ liệu order book
  if (orderBook && orderBook.bids && orderBook.bids.length > 0) {
    // Nhóm lệnh mua theo khoảng giá để tìm các "bức tường" mua lớn
    const groupedBids = {};
    // Điều chỉnh kích thước nhóm theo giá hiện tại
    const priceBucketSize = currentPrice < 0.01 ? 0.00001 : currentPrice < 1 ? 0.0001 : 0.001;
    
    orderBook.bids.forEach(bid => {
      const price = parseFloat(bid[0]);
      const amount = parseFloat(bid[1]);
      const value = price * amount;
      
      // Chỉ xem xét các lệnh có giá trị lớn hơn 50 USDT
      if (value < 50) return;
      
      // Bỏ qua các lệnh giá quá thấp (dưới 10% giá hiện tại)
      if (price < currentPrice * 0.9) return;
      
      const bucketKey = Math.floor(price / priceBucketSize) * priceBucketSize;
      if (!groupedBids[bucketKey]) {
        groupedBids[bucketKey] = { price, amount: 0, value: 0 };
      }
      
      groupedBids[bucketKey].amount += amount;
      groupedBids[bucketKey].value += value;
    });

    // Chuyển đổi nhóm lệnh mua thành mảng
    const bidZones = Object.values(groupedBids);
    
    // Tìm vùng mua có khối lượng lớn
    // Sắp xếp theo giá từ cao xuống thấp, ưu tiên vùng gần giá hiện tại
    const significantZones = bidZones
      .filter(zone => zone.value > volume24h * 0.003) // Điều chỉnh ngưỡng thấp hơn
      .sort((a, b) => {
        // Ưu tiên vùng gần giá hiện tại
        // Nếu 2 vùng cách giá hiện tại dưới 5%, ưu tiên vùng có khối lượng lớn hơn
        const aDistancePercent = (currentPrice - a.price) / currentPrice * 100;
        const bDistancePercent = (currentPrice - b.price) / currentPrice * 100;
        
        if (aDistancePercent < 5 && bDistancePercent < 5) {
          return b.value - a.value; // Sắp xếp theo khối lượng
        }
        
        return aDistancePercent - bDistancePercent; // Sắp xếp theo khoảng cách đến giá hiện tại
      });
    
    if (significantZones.length > 0) {
      // Lấy tối đa 2 vùng mua từ order book
      const orderBookZones = significantZones.slice(0, 2);
      
      // Kết hợp với vùng mua mặc định ở trên
      // Chỉ thêm vùng mặc định nếu không trùng với vùng từ order book
      const combinedZones = [...orderBookZones];
      
      defaultBuyZones.forEach(defaultZone => {
        // Kiểm tra xem vùng mặc định có gần với vùng nào từ order book không
        const hasSimilarZone = orderBookZones.some(zone => 
          Math.abs(zone.price - defaultZone.price) / defaultZone.price < 0.02 // Trong phạm vi 2%
        );
        
        if (!hasSimilarZone) {
          combinedZones.push(defaultZone);
        }
      });
      
      // Sắp xếp lại theo giá giảm dần (cách giá hiện tại tăng dần)
      return combinedZones.sort((a, b) => b.price - a.price).slice(0, 3);
    }
  }
  
  // Nếu không có dữ liệu order book, phân tích lịch sử giao dịch
  const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
  const buyTrades = trades.filter(t => parseInt(t.time) >= threeHoursAgo && !t.isBuyerMaker);
  
  if (buyTrades.length >= 5) {
    const groupedTrades = {};
    const tradeWindow = currentPrice < 0.01 ? 0.0001 : currentPrice < 1 ? 0.001 : 0.01;
    
    buyTrades.forEach(trade => {
      const price = parseFloat(trade.price);
      const qty = parseFloat(trade.qty);
      const value = price * qty;
      
      // Bỏ qua các giao dịch có giá quá thấp
      if (price < currentPrice * 0.9) return;
      
      const priceKey = Math.floor(price / tradeWindow) * tradeWindow;
      
      if (!groupedTrades[priceKey]) {
        groupedTrades[priceKey] = { price, amount: 0, value: 0 };
      }
      
      groupedTrades[priceKey].amount += qty;
      groupedTrades[priceKey].value += value;
    });

    // Tìm vùng mua có lịch sử giao dịch mạnh
    const historicalZones = Object.values(groupedTrades)
      .filter(zone => zone.value > volume24h * 0.002)
      .sort((a, b) => {
        // Ưu tiên vùng gần giá hiện tại
        const aDistance = Math.abs(currentPrice - a.price);
        const bDistance = Math.abs(currentPrice - b.price);
        
        // Nếu khoảng cách tương đối gần nhau, ưu tiên khối lượng
        if (Math.abs(aDistance - bDistance) < currentPrice * 0.01) {
          return b.value - a.value;
        }
        
        return aDistance - bDistance;
      });
    
    if (historicalZones.length > 0) {
      // Kết hợp vùng từ lịch sử giao dịch với vùng mặc định
      const combinedZones = [...historicalZones.slice(0, 2)];
      
      defaultBuyZones.forEach(defaultZone => {
        // Kiểm tra xem vùng mặc định có gần với vùng nào từ lịch sử không
        const hasSimilarZone = historicalZones.some(zone => 
          Math.abs(zone.price - defaultZone.price) / defaultZone.price < 0.02 // Trong phạm vi 2%
        );
        
        if (!hasSimilarZone) {
          combinedZones.push(defaultZone);
        }
      });
      
      // Sắp xếp lại theo giá giảm dần và lấy tối đa 3 vùng
      return combinedZones.sort((a, b) => b.price - a.price).slice(0, 3);
    }
  }

  // Nếu không có dữ liệu đủ tốt từ order book và lịch sử giao dịch
  // Trả về các vùng mua mặc định ở các mức giá hợp lý
  return [
    { 
      price: currentPrice * 0.995, // Giảm 0.5% so với giá hiện tại
      amount: Math.round(volume24h * 0.05 / currentPrice),
      value: volume24h * 0.05 
    },
    { 
      price: currentPrice * 0.985, // Giảm 1.5% so với giá hiện tại
      amount: Math.round(volume24h * 0.08 / currentPrice),
      value: volume24h * 0.08
    },
    { 
      price: currentPrice * 0.97, // Giảm 3% so với giá hiện tại
      amount: Math.round(volume24h * 0.12 / currentPrice),
      value: volume24h * 0.12
    }
  ];
}
// =====================================================
// Signal Generation Functions
// =====================================================

// Generate signal message based on price changes and volume
function generateSignalMessage(timeframe, change, buySellRatio, totalVolume) {
  // Enhanced signal quality with more detailed analysis
  let signalMessage = '';
  
  // Handle extreme price movements
  if (change >= 20) {
    signalMessage = `🌋 EXTREME SURGE in ${timeframe}: TCAPY showing parabolic movement with massive buy pressure – FOMO phase detected!`;
  } else if (change >= 15) {
    signalMessage = `🚀 MASSIVE BREAKOUT in ${timeframe}: TCAPY exploding with extreme buy strength – strong momentum building!`;
  } else if (change >= 10) {
    signalMessage = `📈 STRONG BULL RALLY in ${timeframe}: Price accelerating rapidly with institutional buying detected.`;
  } else if (change >= 7) {
    signalMessage = `💥 POWERFUL MOMENTUM in ${timeframe}: Strong buy pressure pushing price higher with conviction.`;
  } else if (change >= 5) {
    signalMessage = `💡 STRONG UPTREND in ${timeframe}: Clear bullish pattern forming with sustained buying.`;
  } else if (change >= 3) {
    signalMessage = `🌟 SOLID BULLISH MOVE in ${timeframe}: Buyers stepping in with confidence – good momentum.`;
  } else if (change >= 2) {
    signalMessage = `✅ POSITIVE TREND in ${timeframe}: Healthy buying momentum with bullish continuation likely.`;
  } else if (change >= 1) {
    signalMessage = `🟢 MILD STRENGTH in ${timeframe}: Market trending upward with steady support.`;
  } else if (change >= 0.5) {
    signalMessage = `📊 GRADUAL GROWTH in ${timeframe}: Slow but steady accumulation phase.`;
  } else if (change >= 0.2) {
    signalMessage = `🌱 EARLY BULLISH SIGNS in ${timeframe}: First signs of accumulation – monitor closely.`;
  } else if (change > -0.2 && change < 0.2) {
    signalMessage = `🌾 CONSOLIDATION PHASE in ${timeframe}: Market taking a breather – often precedes bigger moves.`;
  } else if (change <= -0.2 && change > -0.5) {
    signalMessage = `🌥 MINOR WEAKNESS in ${timeframe}: Slight selling pressure but nothing concerning.`;
  } else if (change <= -0.5 && change > -1) {
    signalMessage = `🟠 MILD CORRECTION in ${timeframe}: Some profit-taking but technical structure remains intact.`;
  } else if (change <= -1 && change > -3) {
    signalMessage = `🔄 PULLBACK ZONE in ${timeframe}: Healthy correction after recent moves.`;
  } else if (change <= -3 && change > -7) {
    signalMessage = `📉 SIGNIFICANT DECLINE in ${timeframe}: Increased selling pressure – watch key support levels.`;
  } else if (change <= -7) {
    signalMessage = `🌀 MAJOR CORRECTION in ${timeframe}: Sharp selloff – potential oversold opportunity for brave traders.`;
  }

  // Add volume analysis
  if (buySellRatio > 2 && totalVolume > 1000) {
    signalMessage += ` 📈 EXTREMELY HIGH buy pressure detected with heavy accumulation!`;
  } else if (buySellRatio > 1.5 && totalVolume > 1000) {
    signalMessage += ` 📈 Strong buy pressure with institutional accumulation patterns.`;
  } else if (buySellRatio < 0.5 && totalVolume > 1000) {
    signalMessage += ` 📉 Heavy distribution detected – potential buying opportunity approaching.`;
  } else if (buySellRatio < 0.8 && totalVolume > 1000) {
    signalMessage += ` 📉 Sellers currently in control – monitor for reversal signs.`;
  } else if (totalVolume > 3000) {
    signalMessage += ` 🔊 Extremely high trading activity with major market participation!`;
  } else if (totalVolume > 2000) {
    signalMessage += ` 🔊 High trading volume indicating strong market interest!`;
  }

  return signalMessage;
}

// =====================================================
// Bot Command Handlers
// =====================================================

// Start command
bot.start((ctx) => {
  ctx.replyWithHTML(`
    💰 <b>Welcome to TCAPY Community Bot</b> 💰
    
  Hello! Explore cryptocurrency data with these commands:
  
  - <code>/start</code> - Show this welcome message
  - <code>/tcapy</code> - See real-time TCAPY investment signals 
  - <code>/coin tcapy</code> - Get detailed info for TCAPY
  - <code>/coin [symbol]</code> - Get details for any cryptocurrency
  - <code>/help</code> - Display all available commands
  
  <i>Serving a community of 500,000+ crypto enthusiasts!</i>
  `);
});

// Help command
bot.help((ctx) => {
  ctx.replyWithHTML(`
    📚 <b>TCAPY Bot Command Guide</b> 📚
    
  Here's everything you can do with this bot:
  
  - <code>/start</code> - Displays the welcome message to get you started
  - <code>/tcapy</code> - Shows real-time investment signals for TCAPY
  - <code>/coin [symbol]</code> - Fetches details for any cryptocurrency:
    • Example: <code>/coin tcapy</code> - Get TCAPY details
    • Example: <code>/coin btc</code> - Get Bitcoin details
  - <code>/help</code> - Shows this guide with all available commands
  
  <i>The bot automatically posts TCAPY updates every 2 hours</i>
  `);
});

// Get group ID command
bot.command('getgroupid', (ctx) => {
  const chatId = ctx.chat.id;
  const threadId = ctx.message?.message_thread_id;
  
  let message = `Group ID: ${chatId}`;
  if (threadId) {
    message += `\nThread ID: ${threadId}`;
  }
  
  ctx.reply(message);
});

// Coin info command
bot.command('coin', async (ctx) => {
  const symbol = ctx.message.text.split(/\s+/)[1]?.trim()?.toUpperCase();
  
  if (!symbol) {
    return ctx.reply('❌ Please provide a coin symbol (e.g., /coin BTC)');
  }
  
  // Show typing status
  await ctx.telegram.sendChatAction(ctx.chat.id, 'typing', {
    message_thread_id: ctx.message.message_thread_id
  }).catch(() => {});
  
  try {
    // Fetch data from CoinMarketCap API
    const coinData = await throttledFetchCmcData(symbol);
    
    if (!coinData) {
      throw new Error('Coin not found');
    }
    
    // Special case for TCAPY with custom circulating supply
    const circulatingSupply = symbol === 'TCAPY' ? 888_000_000_000 : coinData.circulating_supply;
    const marketCap = coinData.price * circulatingSupply;
    
    // Construct the response message
    let message = `
📈 <b>${coinData.name} (${symbol})</b>
💰 <b>Current Price:</b> $${formatPrice(coinData.price)}
📊 <b>24h Change:</b> ${formatNumber(coinData.percent_change_24h, 2)}%
📊 <b>1h Change:</b> ${formatNumber(coinData.percent_change_1h, 2)}%
🔄 <b>24h Volume:</b> $${formatNumber(coinData.volume24h, 0)}
🔄 <b>Market Cap:</b> $${formatNumber(marketCap, 0)}
    `;
    
    // Add supply information
    if (symbol === 'TCAPY') {
      message += `🔢 <b>Total Supply:</b> 888,000,000,000 TCAPY\n`;
      
      // Special message for TCAPY
      message += `
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
    } else {
      // For other coins, show regular supply info
      if (coinData.circulating_supply) {
        message += `🔢 <b>Circulating Supply:</b> ${formatNumber(coinData.circulating_supply, 0)} ${symbol}\n`;
      }
      if (coinData.max_supply) {
        message += `🔢 <b>Max Supply:</b> ${formatNumber(coinData.max_supply, 0)} ${symbol}\n`;
      }
    }

    // Add chart link
    message += `\n🔗 <a href="https://coinmarketcap.com/currencies/${coinData.slug}/">View Chart</a>`;

    // Inline keyboard with buttons
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.url('Chart', `https://coinmarketcap.com/currencies/${coinData.slug}/`),
        Markup.button.url('Trade', `https://www.mexc.com/exchange/${symbol}_USDT`)
      ],
      [
        Markup.button.url('News', `https://coinmarketcap.com/currencies/${coinData.slug}/news/`),
        Markup.button.callback('Refresh', `refresh_${symbol}`)
      ],
    ]);

    await ctx.replyWithHTML(message, keyboard);
    logger.info(`Coin info sent for ${symbol}`);
    
  } catch (error) {
    // Enhanced error handling with specific error messages
    let errorMessage = 'Unable to retrieve data';
    
    if (error.response) {
      const { status, data } = error.response;
      const apiError = data?.status?.error_message;
      
      switch (status) {
        case 400:
          errorMessage = 'Invalid request. Please check the coin symbol (e.g., use BTC, ETH, etc.).';
          break;
        case 401:
          errorMessage = 'API authentication error. Please try again later.';
          break;
        case 403:
          errorMessage = 'Access denied. Please try again later.';
          break;
        case 429:
          errorMessage = 'Rate limit exceeded. Please try again in a few minutes.';
          break;
        case 500:
          errorMessage = 'Server error. Please try again later.';
          break;
        default:
          errorMessage = 'An unexpected error occurred.';
      }
      
      if (apiError) {
        errorMessage += ` Details: ${apiError}`;
      }
    } else if (error.message === 'Coin not found') {
      errorMessage = `❌ Coin "${symbol}" not found. Please check the symbol and try again.`;
    } else {
      errorMessage = `Error: ${error.message}`;
    }
    
    logger.error('Error in /coin command', { 
      symbol, 
      error: error.message, 
      status: error.response?.status
    });
    
    await ctx.reply(errorMessage);
  }
});
// TCAPY command handler
bot.command(['tcapy', 'tcapy@Tcapy_bot'], async (ctx) => {
  // Convert IDs to strings for proper comparison
  const chatId = ctx.chat.id.toString();
  const configuredChatId = GROUP_CHAT_ID ? GROUP_CHAT_ID.toString() : null;
  
  // Thread IDs
  const threadId = ctx.message?.message_thread_id ? ctx.message.message_thread_id.toString() : null;
  const configuredThreadId = MESSAGE_THREAD_ID ? MESSAGE_THREAD_ID.toString() : null;
  
  // Improved permission check with better logging
  let permissionDenied = false;
  let permissionMessage = '';
  
  // If GROUP_CHAT_ID is set, check if command is in correct chat
  if (configuredChatId && chatId !== configuredChatId) {
    logger.info(`Command rejected - requested in chat ${chatId}, configured for ${configuredChatId}`);
    permissionDenied = true;
    permissionMessage = '❌ This command is only available in the designated group.';
  }
  
  // If MESSAGE_THREAD_ID is set and we're in a forum, check if correct thread
  if (!permissionDenied && configuredThreadId && threadId !== configuredThreadId && ctx.chat.is_forum) {
    logger.info(`Command rejected - requested in thread ${threadId}, configured for ${configuredThreadId}`);
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
  }
  
  // Send message that we're collecting data
  let statusMsg;
  try {
    statusMsg = await ctx.reply('🔄 Collecting real-time TCAPY data, please wait...', {
      message_thread_id: threadId ? parseInt(threadId, 10) : undefined
    });
  } catch (error) {
    logger.warn(`Could not send status message: ${error.message}`);
  }
  
  try {
    // Call the signal generation function
    await sendTcapySignal(ctx);
    
    // Delete status message if successful
    if (statusMsg) {
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
      } catch (error) {
        logger.debug(`Could not delete status message: ${error.message}`);
      }
    }
  } catch (error) {
    logger.error(`Error executing /tcapy command: ${error.message}`, { stack: error.stack });
    
    try {
      const errorMsg = '❌ Failed to retrieve TCAPY data. Please try again later.';
      if (statusMsg) {
        // Edit existing message instead of creating a new one
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          undefined,
          errorMsg
        );
      } else {
        await ctx.reply(errorMsg, {
          message_thread_id: threadId ? parseInt(threadId, 10) : undefined
        });
      }
    } catch (replyError) {
      logger.error(`Could not send error message: ${replyError.message}`);
    }
  }
});

// =====================================================
// Signal Generation and Sending
// =====================================================

// Main function to generate and send TCAPY signals
async function sendTcapySignal(ctx = null) {
  try {
    // Determine chat and thread ID based on context or environment variables
    const chatId = ctx?.chat?.id || GROUP_CHAT_ID;
    const messageThreadId = ctx?.message?.message_thread_id || MESSAGE_THREAD_ID;
    
    logger.info('Starting TCAPY signal generation', { chatId, messageThreadId });
    
    const symbol = 'TCAPYUSDT';
    
    // Fetch data in parallel to improve performance
    const [cmcData, mexcVolume, trades, orderBook] = await Promise.all([
      throttledFetchCmcData('TCAPY').catch(err => {
        logger.error('Failed to fetch CMC data', { error: err.message });
        return { price: 0, volume24h: 0 };
      }),
      fetchMexc24hVolume(symbol),
      fetchTradeHistory(symbol, 1000).catch(err => {
        logger.error('Failed to fetch trade history', { error: err.message });
        return [];
      }),
      fetchOrderBook(symbol, 100)
    ]);
    
    // Validate trade data
    if (!trades || trades.length === 0) {
      throw new Error('No trade data available');
    }
    
    // Get current price from most recent trade
    const currentPrice = parseFloat(trades[0].price);
    if (isNaN(currentPrice)) {
      throw new Error('Invalid current price');
    }
    
    // Define time periods for analysis
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const thirtyMinutesAgo = now - 30 * 60 * 1000;
    const fifteenMinutesAgo = now - 15 * 60 * 1000;
    const fourHoursAgo = now - 4 * 60 * 60 * 1000;
    
    // Calculate actual volumes for different time periods
    const actualOneHourData = calculateVolume(trades, oneHourAgo);
    const actualThirtyMinData = calculateVolume(trades, thirtyMinutesAgo);
    const actualFifteenMinData = calculateVolume(trades, fifteenMinutesAgo);
    const actualFourHourData = calculateVolume(trades, fourHoursAgo);
    
    // Find prices at different time periods
    const price15MinAgo = getPriceAtTime(trades, fifteenMinutesAgo) || currentPrice;
    const price30MinAgo = getPriceAtTime(trades, thirtyMinutesAgo) || currentPrice;
    const price1HourAgo = getPriceAtTime(trades, oneHourAgo) || currentPrice;
    const price4HourAgo = getPriceAtTime(trades, fourHoursAgo) || currentPrice;
    
    // Calculate price changes
    const change15Min = ((currentPrice - price15MinAgo) / price15MinAgo * 100);
    const change30Min = ((currentPrice - price30MinAgo) / price30MinAgo * 100);
    const change1Hour = ((currentPrice - price1HourAgo) / price1HourAgo * 100);
    const change4Hour = ((currentPrice - price4HourAgo) / price4HourAgo * 100);
    
    // Use CMC volume if available, fallback to MEXC volume
    const volume24h = cmcData.volume24h > 0 ? cmcData.volume24h : mexcVolume;
    
    // Trade data for volume estimation
    const tradeData = {
      currentPrice,
      change15Min,
      change30Min,
      change1Hour,
      change4Hour
    };
    
    // Estimate volumes for different time periods
    const estimatedVolumes = estimateVolumeDistribution(volume24h, tradeData);
    
    // Choose between actual and estimated volumes based on data quality
    const isActualVolumeReliable = (volume) => {
      return (parseFloat(volume.totalBuyValue) + parseFloat(volume.totalSellValue)) > (volume24h * 0.01);
    };
    
    const oneHourData = isActualVolumeReliable(actualOneHourData) ? actualOneHourData : estimatedVolumes.hour1;
    const thirtyMinData = isActualVolumeReliable(actualThirtyMinData) ? actualThirtyMinData : estimatedVolumes.min30;
    const fifteenMinData = isActualVolumeReliable(actualFifteenMinData) ? actualFifteenMinData : estimatedVolumes.min15;
    
    // Generate key buy zones
    const buyZones = generateBuyZones(trades, orderBook, currentPrice, volume24h);
    
    // Build the message
    let message = `<b>🚨 TCAPY/USDT Real-Time Analysis </b>\n\n`;
    message += `<b>💰 Current Price:</b> $${formatPrice(currentPrice)} USDT\n`;
    message += `🕒 15m: ${change15Min.toFixed(2)}% | ⏳ 30m: ${change30Min.toFixed(2)}% | 🕰 1h: ${change1Hour.toFixed(2)}% | 📅 4h: ${change4Hour.toFixed(2)}%\n\n`;
    
    // Find the most significant timeframe for signaling
    const timeframes = [
      { name: '15 Minutes', change: change15Min, data: fifteenMinData },
      { name: '30 Minutes', change: change30Min, data: thirtyMinData },
      { name: '1 Hour', change: change1Hour, data: oneHourData },
      { name: '4 Hours', change: change4Hour, data: actualFourHourData }
    ];
    
    // Sort timeframes by absolute change to find most significant
    const significantTimeframes = [...timeframes].sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
    const primaryTimeframe = significantTimeframes[0];
    
    // Calculate buy/sell ratio for signal generation
    const buyValue = parseFloat(primaryTimeframe.data.totalBuyValue);
    const sellValue = parseFloat(primaryTimeframe.data.totalSellValue);
    const totalVolume = buyValue + sellValue;
    const buySellRatio = sellValue === 0 ? 1 : buyValue / sellValue;
    
    // Generate signal message
    const signalMessage = generateSignalMessage(
      primaryTimeframe.name, 
      primaryTimeframe.change, 
      buySellRatio, 
      totalVolume
    );
    
    // Add alert for significant price movements
    if (Math.abs(change15Min) >= 5 || Math.abs(change1Hour) >= 10) {
      message += `<b>⚠️ ALERT: Significant Price Movement Detected!</b>\n`;
    }
    
    // Add signal message
    message += `${signalMessage}\n`;
    
    // Add volume analysis
    message += `\n<b>📊 Volume Analysis (Last 24h: $${formatNumber(volume24h, 0)})</b>\n`;
    
    // Display Sell Orders (Asks)
    message += `\n🔴 <b>Sell Orders (Asks)</b>\n`;
    timeframes.slice(0, 3).forEach(({ name, data }) => {
      const sellValue = parseFloat(data.totalSellValue);
      const sellAmount = parseFloat(data.totalSellAmount);
      message += `- <b>Last ${name}:</b> $${formatNumber(sellValue, 0)} | ${formatNumber(sellAmount, 0)} TCAPY\n`;
    });
    
    // Display Buy Orders (Bids)
    message += `\n🟢 <b>Buy Orders (Bids)</b>\n`;
    timeframes.slice(0, 3).forEach(({ name, data }) => {
      const buyValue = parseFloat(data.totalBuyValue);
      const buyAmount = parseFloat(data.totalBuyAmount);
      message += `- <b>Last ${name}:</b> $${formatNumber(buyValue, 0)} | ${formatNumber(buyAmount, 0)} TCAPY\n`;
    });
    
    // Display Buy/Sell Ratio
    const totalBuyValue = parseFloat(oneHourData.totalBuyValue);
    const totalSellValue = parseFloat(oneHourData.totalSellValue);
    const hourlyRatio = totalSellValue === 0 ? '∞' : (totalBuyValue / totalSellValue).toFixed(2);
    
    message += `\n<b>Buy/Sell Ratio (1h):</b> ${hourlyRatio} ${hourlyRatio > 1 ? '📈' : '📉'}\n`;
    
    // Display Top Buy Zones
    if (buyZones.length > 0) {
      message += `\n<b>🏆 Top Buy Zones Right Now</b> 💡\n`;
      buyZones.forEach(({ price, amount, value }, index) => {
        message += `${index + 1}. $${formatPrice(price)} | $${formatNumber(value, 0)} | ${formatNumber(amount, 0)} TCAPY\n`;
      });
    } else {
      message += `\n🟢 No significant buy zones detected in recent trading activity.\n`;
    }
    
    // Add market metrics
    const circulatingSupply = 888_000_000_000;
    const marketCap = currentPrice * circulatingSupply;
    
    message += `\n<b>📊 Market Metrics</b>`;
    message += `\n<b>- Market Cap:</b> $${formatNumber(marketCap, 0)}`;
    message += `\n<b>- Total Volume 24H:</b> $${formatNumber(volume24h, 0)}`;
    message += `\n<b>- Circulating Supply:</b> 888,000,000,000\n`;
    
    // Add technical trend indicator
    const technicalTrend = change1Hour > 0 && change4Hour > 0 ? 'Bullish 📈' :
                          change1Hour < 0 && change4Hour < 0 ? 'Bearish 📉' : 
                          'Neutral ↔️';
    
    message += `\n<b>Technical Trend:</b> ${technicalTrend}\n`;
    
    // Footer with links
    message += `\n🔗 <a href="https://www.mexc.com/exchange/TCAPY_USDT">Trade on MEXC</a> | <a href="https://coinmarketcap.com/currencies/toncapy/">View on CMC</a>`;
    message += `\n📚 <b>Use /tcapy for real-time updates | /help for all commands</b>`; 
    message += `\n🌐 Powered by <b>TCAPY Community Bot</b> | Serving 500K+ traders`;
    
    // Send message with appropriate thread ID if specified
    if (ctx) {
      // If called from a command handler
      await ctx.replyWithHTML(message, { 
        disable_web_page_preview: true,
        message_thread_id: messageThreadId
      });
    } else {
      // If called from scheduled task
      await bot.telegram.sendMessage(chatId, message, { 
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        message_thread_id: messageThreadId 
      });
    }
    
    logger.info('Sent TCAPY signal successfully', { timestamp: new Date() });
    return true;
    
  } catch (error) {
    logger.error('Error sending TCAPY signal', { 
      error: error.message,
      stack: error.stack
    });
    
    // If not called from a command handler, try to send error message
    if (!ctx) {
      try {
        await bot.telegram.sendMessage(
          GROUP_CHAT_ID,
          `❌ Error generating TCAPY signal: ${error.message}. Service will retry automatically.`,
          { 
            parse_mode: 'HTML',
            message_thread_id: MESSAGE_THREAD_ID 
          }
        );
      } catch (msgError) {
        logger.error('Failed to send error message', { error: msgError.message });
      }
    }
    
    throw error;
  }
}

// =====================================================
// Automatic Signal Scheduler
// =====================================================

// Create a cache for storing last update time to prevent duplicate signals
const signalCache = {
  lastUpdateTime: 0,
  isUpdating: false,
  errorCount: 0,
  maxErrorCount: 5,
  resetErrorCount: function() {
    this.errorCount = 0;
  },
  incrementErrorCount: function() {
    this.errorCount++;
    return this.errorCount;
  }
};

// Định nghĩa khoảng thời gian kiểm tra (15 phút = 900,000ms)
const CHECK_INTERVAL = 900000;
let signalTimer = null;

// Schedule automatic signals with improved error handling
async function scheduleAutomaticSignal() {
  // Prevent concurrent updates
  if (signalCache.isUpdating) {
    logger.debug('Update already in progress, skipping');
    return;
  }
  
  signalCache.isUpdating = true;
  
  try {
    logger.info('Starting scheduled TCAPY signal update');
    await sendTcapySignal();
    
    // Update timestamp and reset error count on success
    signalCache.lastUpdateTime = Date.now();
    signalCache.resetErrorCount();
    
    logger.info('Scheduled TCAPY signal completed successfully');
  } catch (error) {
    // Increment error count and log
    const errorCount = signalCache.incrementErrorCount();
    logger.error(`Scheduled signal update failed (${errorCount}/${signalCache.maxErrorCount})`, {
      error: error.message
    });
    
    // If we've hit max consecutive errors, notify but continue trying
    if (errorCount === signalCache.maxErrorCount) {
      try {
        await bot.telegram.sendMessage(
          GROUP_CHAT_ID,
          `⚠️ <b>System Alert:</b> The TCAPY signal service has encountered multiple consecutive errors. Our team has been notified and is investigating. Updates will continue automatically when the issue is resolved.`,
          { 
            parse_mode: 'HTML',
            message_thread_id: MESSAGE_THREAD_ID 
          }
        );
      } catch (notifyError) {
        logger.error('Failed to send error notification', { error: notifyError.message });
      }
    }
  } finally {
    signalCache.isUpdating = false;
  }
}
// Function to check if we need to send a signal based on time
function shouldSendSignal() {
  const now = Date.now();
  const timeSinceLastUpdate = now - signalCache.lastUpdateTime;
  
  // Nếu chưa có cập nhật trước đó hoặc đã hơn 2 giờ (7200000ms)
  if (signalCache.lastUpdateTime === 0 || timeSinceLastUpdate >= SIGNAL_INTERVAL) {
    logger.info(`Time to send signal: Last update was ${timeSinceLastUpdate / 1000 / 60} minutes ago`);
    return true;
  }
  
  logger.debug(`Not time to send signal yet: ${Math.round((SIGNAL_INTERVAL - timeSinceLastUpdate) / 1000 / 60)} minutes remaining`);
  return false;
}
const SIGNAL_INTERVAL = 14400000; // 4 hours in milliseconds

// Setup signal timer with improved error handling
function startAutomaticSignals() {
  if (signalTimer) {
    clearInterval(signalTimer);
    logger.info('Previous signal timer cleared');
  }
  
  // First signal 1 minute after startup
  logger.info('Scheduling first signal in 1 minute');
  setTimeout(async () => {
    try {
      logger.info('Sending initial signal');
      await scheduleAutomaticSignal();
      logger.info('Initial signal completed');
    } catch (error) {
      logger.error('Error sending initial signal', { error: error.message });
    }
    
    // Setup recurring checks every 15 minutes
    logger.info(`Setting up signal checks every ${CHECK_INTERVAL / 60000} minutes`);
    signalTimer = setInterval(async () => {
      try {
        logger.info('Running periodic signal check');
        if (shouldSendSignal()) {
          await scheduleAutomaticSignal();
        }
      } catch (checkError) {
        logger.error('Error during signal check', { error: checkError.message });
      }
    }, CHECK_INTERVAL);
    
    logger.info('Automatic signal schedule initialized successfully');
  }, 60000);
}

// =====================================================
// Bot Error Handling
// =====================================================

// Handle global bot errors
bot.catch((err, ctx) => {
  logger.error('Bot error', {
    error: err.message,
    stack: err.stack,
    updateType: ctx?.updateType,
    chat: ctx?.chat?.id,
    user: ctx?.from?.id
  });
  
  // Attempt to notify user
  if (ctx && ctx.reply) {
    ctx.reply('An error occurred while processing your request. Please try again later.')
      .catch(replyErr => {
        logger.error('Failed to send error reply', { error: replyErr.message });
      });
  }
});

// =====================================================
// Launch Bot
// =====================================================

// Start the bot with proper error handling
// Start the bot with proper error handling
async function launchBot() {
  try {
    await bot.launch();
    logger.info('Bot started successfully', {
      username: bot.botInfo?.username
    });
    
    // CRITICAL: Make sure this line is executed
    logger.info('Initializing automatic signal updates');
    startAutomaticSignals();
    logger.info('Signal updates initialized');
    
    // Setup graceful stop
    process.once('SIGINT', () => {
      logger.info('SIGINT signal received, stopping bot');
      bot.stop('SIGINT');
    });
    
    process.once('SIGTERM', () => {
      logger.info('SIGTERM signal received, stopping bot');
      bot.stop('SIGTERM');
    });
    
    return true;
  } catch (error) {
    logger.error('Failed to start bot', {
      error: error.message,
      stack: error.stack
    });
    
    // Attempt to restart after delay if this was an unexpected error
    setTimeout(() => {
      logger.info('Attempting to restart bot');
      launchBot();
    }, 30000);
    
    return false;
  }
}

// Thêm vào phần Bot Command Handlers
bot.action(/refresh_(.+)/, async (ctx) => {
  const symbol = ctx.match[1];
  await ctx.answerCbQuery(`Refreshing ${symbol} data...`);
  
  // Simulate coin command
  const fakeMsgCtx = {...ctx};
  fakeMsgCtx.message = {
    text: `/coin ${symbol}`,
    message_thread_id: ctx.message?.message_thread_id
  };
  
  // Process command
  await bot.handleUpdate({
    update_id: ctx.update.update_id,
    message: fakeMsgCtx.message
  });
});

// Thêm lệnh debug để kiểm tra
bot.command('debug', async (ctx) => {
  if (ctx.from.id.toString() !== process.env.ADMIN_ID) {
    return ctx.reply('⛔ This command is restricted to admin use only.');
  }
  
  const debugInfo = {
    botRuntime: process.uptime(),
    lastSignal: signalCache.lastUpdateTime ? new Date(signalCache.lastUpdateTime).toISOString() : 'None',
    isUpdating: signalCache.isUpdating,
    errorCount: signalCache.errorCount,
    nextScheduled: signalTimer ? 'Active' : 'Not set',
    memoryUsage: process.memoryUsage()
  };
  
  await ctx.replyWithHTML(`<b>Debug Info:</b>\n<pre>${JSON.stringify(debugInfo, null, 2)}</pre>`);
});

// Launch the bot
launchBot();

// Export bot instance for testing
export { bot, sendTcapySignal };