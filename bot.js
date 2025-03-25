import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto';

// Fix path for .env in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '.env') });


// Validate environment variables
console.log('Environment variables:', { 
  BOT_TOKEN: process.env.BOT_TOKEN ? '***' : 'MISSING',
  CMC_API_KEY: process.env.CMC_API_KEY ? '***' : 'MISSING',
  MEXC_API_KEY: process.env.MEXC_API_KEY ? '***' : 'MISSING',
  MEXC_API_SECRET: process.env.MEXC_API_SECRET ? '***' : 'MISSING',
  GROUP_CHAT_ID: process.env.GROUP_CHAT_ID ? '***' : 'MISSING',

});


// EnvEnv
const bot = new Telegraf(process.env.BOT_TOKEN);
const CMC_API_KEY = process.env.CMC_API_KEY;
const MEXC_API_KEY = process.env.MEXC_API_KEY;
const MEXC_API_SECRET = process.env.MEXC_API_SECRET;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;

bot.on('message', (ctx, next) => {
  if (ctx.chat.id.toString() !== GROUP_CHAT_ID.toString()) return;
  return next();
});


// Hàm định dạng giá
function formatPrice(price) {
  return parseFloat(price).toFixed(6).replace(/\.?0+$/, '');
}

// Hàm tạo signature cho MEXC API
function createSignature(queryString) {
  return crypto.createHmac('sha256', MEXC_API_SECRET).update(queryString).digest('hex');
}

// Start command
bot.start((ctx) => {
  ctx.replyWithHTML(`
💰 <b>Welcome to CoinMarketCap Bot</b> 💰
Hello! Explore cryptocurrency data with these commands:
- <code>/[symbol] </code> - Get details for a specific coin (e.g., /coin Tcapy)
- <code>/help</code> - Display all available commands
  `);
});

// Help command
bot.help((ctx) => {
  ctx.replyWithHTML(`
📚 <b>Command Guide</b>
Here are the commands you can use:
- <code>/start</code> - Show the welcome message
- <code>/Tcapy </code> - Fetch information for a coin (e.g., /coin Tcapy)
- <code>/help</code> - View this command guide
  `);
});

bot.command('coin', async (ctx) => {
  const symbol = ctx.payload.trim().toUpperCase();
  if (!symbol) return ctx.reply('❌ Please provide a coin symbol (e.g., /coin BTC)');

  if (symbol === 'TCAPY') {
    const customMessage = `
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
    await ctx.replyWithHTML(customMessage);
  }

  try {
    const response = await axios.get('https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest', {
      params: { symbol, convert: 'USDT' },
      headers: {
        'X-CMC_PRO_API_KEY': CMC_API_KEY,
        'Accept-Encoding': 'gzip',
      },
      timeout: 10000,
    });

    const coinData = response.data.data[symbol]?.[0];
    if (!coinData) throw new Error('Coin not found');

    const fullyDilutedMarketCapLine = symbol === 'TCAPY' ? `🏛️ <b>Fully Diluted Market Cap:</b> $3,071,222,714.34\n` : '';
    const quote = coinData.quote.USDT;
    const message = `
📈 <b>${coinData.name} (${symbol})</b>
💰 <b>Current Price:</b> $${formatPrice(quote.price)}
📊 <b>24h Change:</b> ${quote.percent_change_24h?.toFixed(2) || 'N/A'}%
📊 <b>1h Change:</b> ${quote.percent_change_1h?.toFixed(2) || 'N/A'}%
${fullyDilutedMarketCapLine}🔄 <b>24h Volume:</b> $${(quote.volume_24h || 0).toLocaleString()}
🔢 <b>Supply Total:</b> ${(coinData.total_supply || 0).toLocaleString()}

🔗 <a href="https://coinmarketcap.com/currencies/${coinData.slug}/">View Chart</a>
    `;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.url('Chart', `https://coinmarketcap.com/currencies/${coinData.slug}/`)],
      [Markup.button.url('News', `https://coinmarketcap.com/currencies/${coinData.slug}/news/`)],
    ]);

    await ctx.replyWithHTML(message, keyboard);
  } catch (error) {
    let errorMessage = 'Unable to retrieve data';
    if (error.response) {
      const { status, data } = error.response;
      const apiError = data?.status?.error_message;
      switch (status) {
        case 400: errorMessage = 'Invalid request. Please check the coin symbol.'; break;
        case 401: errorMessage = 'Invalid API key. Please verify your configuration.'; break;
        case 403: errorMessage = 'Access denied. This may be due to API plan restrictions.'; break;
        case 429: errorMessage = 'Rate limit exceeded. Please try again later.'; break;
        case 500: errorMessage = 'Server error. Please try again later.'; break;
      }
      if (apiError) errorMessage += ` Details: ${apiError}`;
    } else {
      errorMessage = error.message;
    }
    console.error('[ERROR]', { message: error.message, status: error.response?.status, data: error.response?.data });
    await ctx.reply(`❌ Error: ${errorMessage}`);
  }
});


async function fetchTradeHistory(symbol, limit = 1000) {
  try {
    const response = await axios.get('https://api.mexc.com/api/v3/trades', {
      params: { symbol, limit },
      // Uncomment and add your API key if required
      // headers: { 'X-MEXC-APIKEY': MEXC_API_KEY }
    });
    return response.data;
  } catch (error) {
    console.error('[ERROR] Failed to fetch trade history:', error);
    throw error;
  }
}

// Helper function to calculate buy and sell volumes for a time frame
function calculateVolume(trades, startTime) {
  let totalSellValue = 0;
  let totalSellAmount = 0;
  let totalBuyValue = 0;
  let totalBuyAmount = 0;

  trades.forEach(trade => {
    const tradeTime = trade.time; // Timestamp in milliseconds
    if (tradeTime >= startTime) {
      const price = parseFloat(trade.price);
      const qty = parseFloat(trade.qty);
      const value = price * qty;
      if (trade.isBuyerMaker) {
        // Sell order initiated the trade
        totalSellValue += value;
        totalSellAmount += qty;
      } else {
        // Buy order initiated the trade
        totalBuyValue += value;
        totalBuyAmount += qty;
      }
    }
  });

  return {
    totalSellValue: totalSellValue.toFixed(4),
    totalSellAmount: totalSellAmount.toFixed(2),
    totalBuyValue: totalBuyValue.toFixed(4),
    totalBuyAmount: totalBuyAmount.toFixed(2),
  };
}


bot.command('getgroupid', (ctx) => {
  const chatId = ctx.chat.id;
  ctx.reply(`Group ID: ${chatId}`);
});


// Function to send TCAPY info automatically
async function sendTcapyInfoAutomatically() {
  try {
    const chatId = process.env.GROUP_CHAT_ID;
    const symbol = 'TCAPYUSDT';

    // Fetch trade data
    const trades = await fetchTradeHistory(symbol, 1000);
    if (!trades || trades.length === 0) {
      throw new Error('No trade data available');
    }

    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const thirtyMinutesAgo = now - 30 * 60 * 1000;
    const fifteenMinutesAgo = now - 15 * 60 * 1000;

    const oneHourData = calculateVolume(trades, oneHourAgo);
    const thirtyMinData = calculateVolume(trades, thirtyMinutesAgo);
    const fifteenMinData = calculateVolume(trades, fifteenMinutesAgo);

    // Fetch order book data
    const depthResponse = await axios.get('https://api.mexc.com/api/v3/depth', {
      params: { symbol, limit: 5 },
    });
    const { bids, asks } = depthResponse.data;

    // Get current price with validation
    const currentPrice = parseFloat(trades[0].price);
    if (isNaN(currentPrice)) {
      throw new Error('Invalid current price');
    }

    // Function to get price at a specific time
    const getPriceAtTime = (trades, targetTime) => {
      const closestTrade = trades.reduce((prev, curr) => {
        const prevDiff = Math.abs(prev.time - targetTime);
        const currDiff = Math.abs(curr.time - targetTime);
        return currDiff < prevDiff ? curr : prev;
      });
      return parseFloat(closestTrade.price);
    };

    const price15MinAgo = getPriceAtTime(trades, fifteenMinutesAgo);
    const price30MinAgo = getPriceAtTime(trades, thirtyMinutesAgo);
    const price1HourAgo = getPriceAtTime(trades, oneHourAgo);

    // Calculate price changes
    const change15Min = ((currentPrice - price15MinAgo) / price15MinAgo * 100).toFixed(2);
    const change30Min = ((currentPrice - price30MinAgo) / price30MinAgo * 100).toFixed(2);
    const change1Hour = ((currentPrice - price1HourAgo) / price1HourAgo * 100).toFixed(2);

    // Enhanced number formatting function
    const formatNumber = (num, decimals = 2) => {
      if (isNaN(num) || num === null) return 'N/A';
      return parseFloat(num).toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
    };

// Build the Telegram message - Part 1: Header + Price + Price Movement
let message = `<b>🚨 TCAPY/USDT Real-Time Update </b>\n\n`;

message += `<b>💰 Current Price:</b> $${formatNumber(currentPrice, 6)} USDT\n`;
message += `📉 <b>Price Movement:</b>\n`;
message += `🕒 15m: ${change15Min}% | ⏳ 30m: ${change30Min}% | 🕰 1h: ${change1Hour}%\n\n`;


// Xác định khung thời gian có thay đổi giá lớn nhất
const changes = [
  { timeframe: '15 Minutes', change: parseFloat(change15Min), data: fifteenMinData },
  { timeframe: '30 Minutes', change: parseFloat(change30Min), data: thirtyMinData },
  { timeframe: '1 Hour', change: parseFloat(change1Hour), data: oneHourData },
];
const maxChangeTimeframe = changes.reduce((prev, current) => (prev.change > current.change ? prev : current));

// Sử dụng dữ liệu của khung thời gian được chọn
const selectedChange = maxChangeTimeframe.change;
const selectedData = maxChangeTimeframe.data;
const buyValue = parseFloat(selectedData.totalBuyValue);
const sellValue = parseFloat(selectedData.totalSellValue);
const totalVolume = buyValue + sellValue;
const buySellRatio = sellValue === 0 ? 1 : buyValue / sellValue;

// Logicogic signal
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

// Base on buySellRatio và totalVolume
if (buySellRatio > 1.5 && totalVolume > 1000) {
  signalMessage += ` 📈 High buy pressure detected!`;
} else if (buySellRatio < 0.8 && totalVolume > 1000) {
  signalMessage += ` 📉 Potential buying opportunity!`;
} else if (totalVolume > 2000) {
  signalMessage += ` 🔊 Active market with high participation!`;
}

// signam out putput
message += `${signalMessage}\n`;



    // Add alert for significant price change
    if (Math.abs(change15Min) >= 5) {
      message += `🚨 <b>ALERT: Significant price change in the last 15 minutes!</b>\n`;
    }

    message += `\n🔴 <b>Sell Orders (Asks)</b>\n`;
    const timeFrames = [
      { label: '15 Minutes', data: fifteenMinData },
      { label: '30 Minutes', data: thirtyMinData },
      { label: '1 Hour', data: oneHourData },
    ];
    timeFrames.forEach(({ label, data }) => {
      message += `- <b>Last ${label}:</b> $${formatNumber(data.totalSellValue, 2)} | ${formatNumber(data.totalSellAmount, 2)} TCAPY\n`;
    });

    message += `\n🟢 <b>Buy Orders (Bids)</b>\n`;
    timeFrames.forEach(({ label, data }) => {
      message += `- <b>Last ${label}:</b> $${formatNumber(data.totalBuyValue, 2)} | ${formatNumber(data.totalBuyAmount, 2)} TCAPY\n`;
    });


    //part333333333333333part333333333333333
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;

    const groupedBuyZones = {};
    trades
      .filter(trade => trade.time >= threeHoursAgo && !trade.isBuyerMaker) // Real Buy
      .forEach(trade => {
        const price = parseFloat(trade.price).toFixed(6);
        const qty = parseFloat(trade.qty);
        const total = qty * parseFloat(price);
        if (total < 10) return; // ✅ chỉ lọc những lệnh cực nhỏ, giữ lại phần meaningful
        if (!groupedBuyZones[price]) {
          groupedBuyZones[price] = { qty: 0, total: 0 };
        }
        groupedBuyZones[price].qty += qty;
        groupedBuyZones[price].total += total;
      });
    
    const topBuyZones = Object.entries(groupedBuyZones)
      .map(([price, data]) => ({
        price: parseFloat(price),
        qty: data.qty,
        total: data.total,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 3);
    
    if (topBuyZones.length > 0) {
      const maxZoneTotal = topBuyZones[0]?.total || 0;
      let totalBuyZoneVolume = 0;
    
      message += `\n<b>🏆 Top 3 Buy Zones Right Now</b>\n`;
      topBuyZones.forEach(({ price, qty, total }) => {
        totalBuyZoneVolume += total;
        const highlight = total === maxZoneTotal ? '' : '';
        message += `${highlight}$${formatNumber(price, 6)} | ${formatNumber(qty)} TCAPY | $${formatNumber(total)}\n`;
      });
    
      message += `📊 Total Buy Volume: $${formatNumber(totalBuyZoneVolume)}\n`;
    } else {
      message += `\n🟢 No significant buy zones detected in the last 3 hours.\n`;
    }
    

 // 🧾 Part 4: Footer
message += `\n🔗 <a href="https://www.mexc.com/exchange/TCAPY_USDT">View on MEXC</a>`;
message += `\n🌐 Updated by <b>TCAPY Community Bot</b>`;
message += `\n🕒 Auto updates every 10 minutes`;

    // Send the message
    await bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
    console.log('Sent TCAPY info automatically at:', new Date());
  } catch (error) {
    console.error('Error sending TCAPY info automatically:', error.message);
    const chatId = process.env.GROUP_CHAT_ID;
    let errorMessage = '❌ Error fetching TCAPY data.';
    if (error.message === 'No trade data available') {
      errorMessage += ' No recent trades found.';
    } else if (error.message === 'Invalid current price') {
      errorMessage += ' Invalid price data.';
    } else if (error.response) {
      errorMessage += ` API returned status ${error.response.status}.`;
    } else if (error.request) {
      errorMessage += ' No response from API.';
    }
    await bot.telegram.sendMessage(chatId, errorMessage, { parse_mode: 'HTML' });
  }
}

// Schedule to run every 10 minutes (600,000 ms)
setInterval(sendTcapyInfoAutomatically, 600000);
sendTcapyInfoAutomatically(); // Run immediately ngay lần đầu

bot.launch()
  .then(() => console.log('Bot started successfully!'))
  .catch((err) => console.error('Error starting bot:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));