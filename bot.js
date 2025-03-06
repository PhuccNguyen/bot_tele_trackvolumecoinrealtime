import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto'; // Thêm module crypto để tạo signature
import WebSocket from 'ws'; // Added WebSocket import

// Fix path for .env in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '.env') });


// Danh sách chatId của người dùng đăng ký nhận thông báo
const subscribers = new Set(); // For trade notifications (if used elsewhere)
const orderBookSubscribers = new Set(); // Fix: Define this for order book subscribers

// Validate environment variables
console.log('Environment variables:', {
  BOT_TOKEN: process.env.BOT_TOKEN ? '***' : 'MISSING',
  CMC_API_KEY: process.env.CMC_API_KEY ? '***' : 'MISSING',
  MEXC_API_KEY: process.env.MEXC_API_KEY ? '***' : 'MISSING',
  MEXC_API_SECRET: process.env.MEXC_API_SECRET ? '***' : 'MISSING',
});

if (!process.env.BOT_TOKEN || !process.env.CMC_API_KEY) {
  console.error('ERROR: Missing BOT_TOKEN or CMC_API_KEY in .env file');
  process.exit(1);
}



// Khởi tạo bot và các biến môi trường
const bot = new Telegraf(process.env.BOT_TOKEN);
const CMC_API_KEY = process.env.CMC_API_KEY;
const MEXC_API_KEY = process.env.MEXC_API_KEY;
const MEXC_API_SECRET = process.env.MEXC_API_SECRET;

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
- <code>/coin [symbol]</code> - Get details for a specific coin (e.g., /coin BTC)
- <code>/top10</code> - View the top 10 coins by market cap
- <code>/tcapy</code> - Get Tcapy data from MEXC
- <code>/help</code> - Display all available commands
  `);
});

// Help command
bot.help((ctx) => {
  ctx.replyWithHTML(`
📚 <b>Command Guide</b>
Here are the commands you can use:
- <code>/start</code> - Show the welcome message
- <code>/coin [symbol]</code> - Fetch information for a coin (e.g., /coin BTC)
- <code>/top10</code> - List the top 10 coins by market cap
- <code>/tcapy</code> - Get Tcapy data from MEXC
- <code>/help</code> - View this command guide
  `);
});

// Coin command (giữ nguyên từ code của bạn)
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

// Top 10 coins command (giữ nguyên từ code của bạn)
bot.command('top10', async (ctx) => {
  try {
    const response = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest', {
      params: { limit: 10, convert: 'USDT' },
      headers: {
        'X-CMC_PRO_API_KEY': CMC_API_KEY,
        'Accept-Encoding': 'gzip',
      },
      timeout: 10000,
    });

    const coins = response.data.data;
    let message = '🏆 <b>Top 10 Coins by Market Cap</b>\n\n';
    coins.forEach((coin, index) => {
      const quote = coin.quote.USDT;
      message += `${index + 1}. <b>${coin.name} (${coin.symbol})</b>\n`;
      message += `   Price: $${formatPrice(quote.price)}\n`;
      message += `   Market Cap: $${(quote.market_cap || 0).toLocaleString()}\n\n`;
    });
    await ctx.replyWithHTML(message);
  } catch (error) {
    console.error('[ERROR]', error);
    await ctx.reply('❌ Unable to fetch top 10 coins data');
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

// Modified /tcapy command handler
bot.command('tcapy', async (ctx) => {
  try {
    const symbol = 'TCAPYUSDT';

    // Fetch trade history
    const trades = await fetchTradeHistory(symbol, 1000);

    // Define time frames in milliseconds
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000; // 1 hour
    const thirtyMinutesAgo = now - 30 * 60 * 1000; // 30 minutes
    const fifteenMinutesAgo = now - 15 * 60 * 1000; // 15 minutes

    // Calculate volumes for each time frame
    const oneHourData = calculateVolume(trades, oneHourAgo);
    const thirtyMinData = calculateVolume(trades, thirtyMinutesAgo);
    const fifteenMinData = calculateVolume(trades, fifteenMinutesAgo);

    // Fetch current order book
    const depthResponse = await axios.get('https://api.mexc.com/api/v3/depth', {
      params: { symbol, limit: 5 },
    });

    const { bids, asks } = depthResponse.data;

    // Format message
    let message = `📊 <b>Order Book (TCAPY/USDT)</b>\n\n`;

    // Sell Orders - Executed Volumes
    message += `<b>Sell Orders (Asks) - Executed Volumes:</b>\n`;
    const timeFrames = [
      { label: '1 Hour', data: oneHourData },
      { label: '30 Minutes', data: thirtyMinData },
      { label: '15 Minutes', data: fifteenMinData },
    ];
    timeFrames.forEach(({ label, data }) => {
      message += `\n⏳ <i>${label}</i>\n`;
      message += `Total Sell: $${data.totalSellValue}\n`;
      message += `Total Amount: ${data.totalSellAmount} TCAPY\n`;
    });

    // Buy Orders - Executed Volumes
    message += `\n<b>Buy Orders (Bids) - Executed Volumes:</b>\n`;
    timeFrames.forEach(({ label, data }) => {
      message += `\n⏳ <i>${label}</i>\n`;
      message += `Total Buy: $${data.totalBuyValue}\n`;
      message += `Total Amount: ${data.totalBuyAmount} TCAPY\n`;
    });

    // Current Order Book - Top 5 Bids and Asks
    message += `\n🕒 <b>Current Order Book (Top 5)</b>\n`;
    message += `<b>Buy Orders (Bids):</b>\n`;
    bids.slice(0, 5).forEach(([price, amount]) => {
      const total = (parseFloat(price) * parseFloat(amount)).toFixed(2);
      message += `- Price: $${Number(price).toFixed(6)} | Amount: ${Number(amount).toFixed(2)} TCAPY | Total: ${total} USDT\n`;
    });

    message += `\n<b>Sell Orders (Asks):</b>\n`;
    asks.slice(0, 5).forEach(([price, amount]) => {
      const total = (parseFloat(price) * parseFloat(amount)).toFixed(2);
      message += `- Price: $${Number(price).toFixed(6)} | Amount: ${Number(amount).toFixed(2)} TCAPY | Total: ${total} USDT\n`;
    });

    message += `\n🔗 <a href="https://www.mexc.com/exchange/TCAPY_USDT">View on MEXC</a>`;

    // Send the formatted message
    await ctx.replyWithHTML(message);

  } catch (error) {
    console.error('[ERROR]', error);
    await ctx.replyWithHTML('❌ Error fetching TCAPY data, please try again later');
  }
});

bot.command('getgroupid', (ctx) => {
  const chatId = ctx.chat.id;
  ctx.reply(`Group ID: ${chatId}`);
});

// Function to send Tcapy info automatically to a Telegram group
async function sendTcapyInfoAutomatically() {
  try {
    const chatId = '-1002372409968'; // Replace with your Telegram group chat ID
    const symbol = 'TCAPYUSDT';

    // Fetch Tcapy data (reusing logic from the /tcapy command)
    const trades = await fetchTradeHistory(symbol, 1000);
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const thirtyMinutesAgo = now - 30 * 60 * 1000;
    const fifteenMinutesAgo = now - 15 * 60 * 1000;

    const oneHourData = calculateVolume(trades, oneHourAgo);
    const thirtyMinData = calculateVolume(trades, thirtyMinutesAgo);
    const fifteenMinData = calculateVolume(trades, fifteenMinutesAgo);

    const depthResponse = await axios.get('https://api.mexc.com/api/v3/depth', {
      params: { symbol, limit: 5 },
    });
    const { bids, asks } = depthResponse.data;

    // Helper function to format numbers with dots for thousands
    const formatNumber = (num) => parseFloat(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/,/g, '.');

    let message = `               <b> 🚨 TCAPY/USDT Real-Time Update 📊\n</b>`;
message += `                              🔄 Recent Of $TCAPY Trading Activity 🔄\n`;
    message += `🔴 <b> Sell Orders (Asks) </b>\n`;
    const timeFrames = [
      { label: '15 Minutes', data: fifteenMinData },
      { label: '30 Minutes', data: thirtyMinData },
      { label: '1 Hour', data: oneHourData },
    ];
    timeFrames.forEach(({ label, data }) => {
      message += `<b>- Last ${label}</b>\n`;
      message += `  Total Sell: $${formatNumber(data.totalSellValue)}|`;
      message += ` Total Amount: ${formatNumber(data.totalSellAmount)} TCAPY\n`;
    });

    message += `🟢 <b> Buy Orders (Bids)</b> \n`;
    timeFrames.forEach(({ label, data }) => {
      message += `<b>- ⌛ Last ${label}\n</b>`;
      message += `  Total Buy: $${formatNumber(data.totalBuyValue)}|`;
      message += ` Total Amount: ${formatNumber(data.totalBuyAmount)} TCAPY\n`;
    });

    message += `\n<b>Current Order Book (Top 5)\n</b>`;
    message += `These are the top 5 buy and sell orders currently available on MEXC.\n`;
    
    message += `🟢 <b>Buy Orders (Bids)\n</b>`;
    bids.slice(0, 5).forEach(([price, amount]) => {
      const total = parseFloat(price) * parseFloat(amount);
      message += `- Price: $${Number(price).toFixed(6)} | Amount: ${formatNumber(amount)} TCAPY | Total: $${formatNumber(total)} USDT\n`;
    });

    message += `<b>\n🔴 Sell Orders (Asks)\n</b>`;
    asks.slice(0, 5).forEach(([price, amount]) => {
      const total = parseFloat(price) * parseFloat(amount);
      message += `- Price: $${Number(price).toFixed(6)} | Amount: ${formatNumber(amount)} TCAPY | Total: $${formatNumber(total)} USDT\n`;
    });

    message += `\n🔗 [View on MEXC](https://www.mexc.com/exchange/TCAPY_USDT)\n`;
    message += `<b>Data fetched at: ${new Date().toUTCString()}</b>`;

    // Send the message to the Telegram group
    await bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
    console.log('Sent Tcapy info automatically at:', new Date());
  } catch (error) {
    console.error('Error sending Tcapy info automatically:', error);
    // Notify the group if an error occurs
    await bot.telegram.sendMessage(chatId, '❌ Error fetching TCAPY data. Please try again later.', { parse_mode: 'HTML' });
  }
}

// Schedule the function to run every hour (3600000 ms = 1 hour)
setInterval(sendTcapyInfoAutomatically, 600000);

// Execute immediately when the bot starts (optional)
sendTcapyInfoAutomatically();

bot.launch()
  .then(() => console.log('Bot started successfully!'))
  .catch((err) => console.error('Error starting bot:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));