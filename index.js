import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';

dotenv.config();

const token = process.env.TELEGRAM_TOKEN;

if (!token || token.includes(' ') || token.length < 40) {
    console.error('❌ Ошибка токена');
    process.exit(1);
}

const index = new TelegramBot(token, { polling: true });
const activeEvents = {};

// 📁 Хранилище чатов (групп)
const CHATS_FILE = path.join(process.cwd(), 'chats.json');
function loadChats() {
    try {
        if (fs.existsSync(CHATS_FILE)) {
            return new Set(JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8')));
        }
    } catch (e) { console.error('❌ Ошибка загрузки чатов:', e.message); }
    return new Set();
}
function saveChats(chats) {
    try { fs.writeFileSync(CHATS_FILE, JSON.stringify([...chats]), 'utf8'); }
    catch (e) { console.error('❌ Ошибка сохранения чатов:', e.message); }
}
let registeredChats = loadChats();

function registerChat(chatId) {
    if (!registeredChats.has(chatId)) {
        registeredChats.add(chatId);
        saveChats(registeredChats);
        console.log(`✅ Группа ${chatId} добавлена в рассылку`);
    }
}

// 📦 Подписчики (пользователи, которые дали согласие на упоминания)
const SUBSCRIBERS_FILE = path.join(process.cwd(), 'subscribers.json');
let subscribers = [];

function loadSubscribers() {
    try {
        if (fs.existsSync(SUBSCRIBERS_FILE)) {
            subscribers = JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf8'));
            console.log(`👥 Загружено ${subscribers.length} подписчиков`);
        }
    } catch (e) { console.error('❌ Ошибка загрузки subscribers.json:', e.message); }
}
loadSubscribers();

function subscribeUser(userId) {
    if (!subscribers.includes(userId)) {
        subscribers.push(userId);
        fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(subscribers), 'utf8');
        console.log(`✅ Пользователь ${userId} подписался на уведомления`);
    }
}

function unsubscribeUser(userId) {
    const idx = subscribers.indexOf(userId);
    if (idx !== -1) {
        subscribers.splice(idx, 1);
        fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(subscribers), 'utf8');
        console.log(`❌ Пользователь ${userId} отписался`);
    }
}

// 📢 Рассылка с упоминаниями подписчиков + закрепление
async function broadcastToChats(text) {
    console.log(`📢 Рассылка: "${text}" для ${registeredChats.size} групп`);
    
    for (const chatId of registeredChats) {
        try {
            if (subscribers.length > 0) {
                const makeMention = (id) => `<a href="tg://user?id=${id}">\u2060</a>`;
                
                // Разбиваем на пачки по 30 (защита от спам-фильтра)
                const CHUNK_SIZE = 30;
                const chunks = [];
                for (let i = 0; i < subscribers.length; i += CHUNK_SIZE) {
                    const chunk = subscribers.slice(i, i + CHUNK_SIZE);
                    chunks.push(chunk.map(makeMention).join(''));
                }

                // Первое сообщение: упоминания + текст
                const firstChunk = chunks.shift() || '';
                const fullText = `${firstChunk}\n\n${text}`;
                
                const sent = await index.sendMessage(chatId, fullText, { 
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                });
                console.log(`✅ Доставлено в ${chatId} (${subscribers.length} упоминаний)`);

                // 📌 Закрепляем первое сообщение
                try {
                    await index.pinChatMessage(chatId, sent.message_id, { disable_notification: true });
                } catch (pinErr) {
                    console.warn(`⚠️ Не удалось закрепить:`, pinErr.message);
                }

                // Остальные пачки упоминаний
                for (const chunk of chunks) {
                    await index.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
                    await new Promise(res => setTimeout(res, 1000));
                }
            } else {
                // Нет подписчиков — обычное сообщение
                await index.sendMessage(chatId, text, { parse_mode: 'HTML' });
                console.log(`✅ Доставлено в ${chatId} (без упоминаний)`);
            }

        } catch (err) {
            console.warn(`⚠️ Ошибка в чате ${chatId}:`, err.message);
            if (err.response?.body?.error_code === 403) {
                registeredChats.delete(chatId);
                saveChats(registeredChats);
            }
        }
        await new Promise(res => setTimeout(res, 50));
    }
}

console.log('🚀 Бот запущен...');
index.getMe().then(user => {
    console.log(`✅ Авторизован как: @${user.username}`);
}).catch(err => console.error('❌ Ошибка авторизации:', err.message));

// 🕛 Ежедневная рассылка в 12:00
cron.schedule('0 12 * * *', () => {
    console.log('⏰ Время рассылки: 12:00');
    broadcastToChats('🏪 <b>Зайдите к торговцу!</b>\nНе забудьте забрать ежедневные награды! ⚔️');
}, { timezone: 'Europe/Moscow' });

// 🧪 ТЕСТ каждые 2 минуты (удали этот блок после тестов)
cron.schedule('*/2 * * * *', () => {
    console.log('🧪 [ТЕСТ] Рассылка каждые 2 минуты');
    broadcastToChats('🧪 <b>Тест</b>\nПроверка связи. Удали этот код после тестов! ⚔️');
}, { timezone: 'Europe/Moscow' });

console.log('📅 Запланирована рассылка на 12:00 + тест каждые 2 мин');

// --- ФУНКЦИЯ ПРОВЕРКИ АДМИНА ---
async function isAdmin(chatId, userId) {
    try {
        const admins = await index.getChatAdministrators(chatId);
        return admins.some(admin => admin.user.id === userId);
    } catch (error) {
        console.error('Ошибка проверки прав:', error.message);
        return false;
    }
}

// 1. Команда /start
index.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userName = msg.from.first_name;
    
    // Если группа — регистрируем её и показываем кнопку подписки
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
        registerChat(chatId);
        index.sendMessage(chatId, `Привет, ${userName}! 👋\nЯ бот для сбора на клановые ивенты.`, {
            reply_markup: {
                inline_keyboard: [[
                    { 
                        text: "🔔 Получать уведомления", 
                        url: `https://t.me/${index.options.username}?start=subscribe` 
                    }
                ]]
            }
        });
        return;
    }
    
    // Если личка и /start без параметров
    if (msg.chat.type === 'private') {
        index.sendMessage(chatId, `Привет, ${userName}! 👋\n\nХочешь получать уведомления о посещении торговца?`, {
            reply_markup: {
                inline_keyboard: [[
                    { text: "✅ Да, подписать меня", callback_data: "subscribe_yes" },
                    { text: "❌ Нет, спасибо", callback_data: "subscribe_no" }
                ]]
            }
        });
    }
});

// Обработка /start subscribe (переход из группы по кнопке)
index.onText(/\/start subscribe/, (msg) => {
    if (msg.chat.type !== 'private') return;
    const userName = msg.from.first_name;
    index.sendMessage(msg.chat.id, `🔔 ${userName}, подтвердить подписку на уведомления?`, {
        reply_markup: {
            inline_keyboard: [[
                { text: "✅ Да, подписать", callback_data: "subscribe_yes" },
                { text: "❌ Нет", callback_data: "subscribe_no" }
            ]]
        }
    });
});

// Команда /unsubscribe (в личке)
index.onText(/\/unsubscribe/, (msg) => {
    if (msg.chat.type !== 'private') {
        return index.sendMessage(msg.chat.id, '❌ Эта команда работает только в личных сообщениях с ботом');
    }
    unsubscribeUser(msg.from.id);
    index.sendMessage(msg.chat.id, '✅ Вы отписаны от уведомлений. Чтобы подписаться снова: /start');
});

// Обработка кнопок (подписка + ивенты)
index.on('callback_query', (query) => {
    // 🔹 Подписка на уведомления
    if (query.data === 'subscribe_yes') {
        subscribeUser(query.from.id);
        index.answerCallbackQuery(query.id, { text: '✅ Вы подписаны!' });
        index.sendMessage(query.message.chat.id, '✅ Готово! Теперь вы будете получать уведомления.\nОтписаться: /unsubscribe');
        return;
    }
    if (query.data === 'subscribe_no') {
        index.answerCallbackQuery(query.id, { text: 'Ок' });
        index.sendMessage(query.message.chat.id, '👌 Хорошо, если передумаете — напишите /start');
        return;
    }
    
    // 🔹 Присоединение к ивенту (старая логика)
    if (query.data === 'join_event') {
        joinEvent(query.message.chat.id, query.from.id, query.from.first_name, query.message.message_id, query.id);
        return;
    }
});

// 2. Запуск ивента: /event_start [секунды]
index.onText(/\/event_start(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const durationSec = parseInt(match[1]) || 300;

    if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
        index.sendMessage(chatId, 'Эта команда работает только в группах!');
        return;
    }

    const isUserAdmin = await isAdmin(chatId, userId);
    if (!isUserAdmin) {
        index.sendMessage(chatId, '⛔ У вас нет прав. Только админы могут запускать ивент.');
        return;
    }

    if (activeEvents[chatId]) {
        index.sendMessage(chatId, '⚠️ Сбор уже идет! Используйте /event_stop.');
        return;
    }

    console.log(`📢 Админ ${msg.from.first_name} запустил сбор на ${durationSec} сек.`);
    activeEvents[chatId] = { participants: [], startTime: Date.now(), duration: durationSec * 1000 };

    index.sendMessage(chatId, `📢 **АДМИН ЗАПУСТИЛ СБОР НА ИВЕНТ!**\n⏳ Время сбора: ${Math.floor(durationSec / 60)} мин.\n\nНажмите кнопку ниже, чтобы записаться!`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: "⚔️ Я в деле!", callback_data: "join_event" }]] }
    }).then((sentMessage) => { activeEvents[chatId].msgId = sentMessage.message_id; });

    const timerId = setTimeout(() => finishEvent(chatId), durationSec * 1000);
    activeEvents[chatId].timerId = timerId;
});

// 3. Обработка кнопки /join
index.onText(/\/join/, (msg) => {
    if (activeEvents[msg.chat.id]) {
        joinEvent(msg.chat.id, msg.from.id, msg.from.first_name, null, null);
    } else {
        index.sendMessage(msg.chat.id, '❌ Нет активного сбора.');
    }
});

function joinEvent(chatId, userId, userName, messageId = null, queryId = null) {
    const event = activeEvents[chatId];
    if (!event) return;

    if (event.participants.some(p => p.id === userId)) {
        if (queryId) index.answerCallbackQuery(queryId, { text: 'Вы уже в списке!', show_alert: true });
        else index.sendMessage(chatId, 'Вы уже записаны! ✅');
        return;
    }

    event.participants.push({ id: userId, name: userName });
    const count = event.participants.length;
    const timeLeft = Math.max(0, Math.ceil((event.duration - (Date.now() - event.startTime)) / 1000));

    if (messageId && queryId) {
        const newText = `📢 **СБОР НА ИВЕНТ**\n⏳ Осталось: ${timeLeft} сек.\n👥 Участников: ${count}\n\nПоследний присоединился: ${userName}`;
        index.editMessageText(newText, {
            chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: "⚔️ Я в деле!", callback_data: "join_event" }]] }
        }).catch(() => {});
        index.answerCallbackQuery(queryId, { text: 'Вы успешно добавлены! ⚔️' });
    } else {
        index.sendMessage(chatId, `✅ ${userName} присоединился! (Всего: ${count})`);
    }
}

// 4. Остановка /event_stop
index.onText(/\/event_stop/, async (msg) => {
    const chatId = msg.chat.id;
    const isUserAdmin = await isAdmin(chatId, msg.from.id);
    if (!isUserAdmin) {
        index.sendMessage(chatId, '⛔ Только админы могут остановить сбор.');
        return;
    }
    if (activeEvents[chatId]) {
        clearTimeout(activeEvents[chatId].timerId);
        delete activeEvents[chatId];
        index.sendMessage(chatId, '🛑 Сбор отменен администратором.');
    } else {
        index.sendMessage(chatId, 'Нет активного сбора.');
    }
});

// Финал ивента
function finishEvent(chatId) {
    const event = activeEvents[chatId];
    if (!event) return;
    clearTimeout(event.timerId);
    delete activeEvents[chatId];

    const count = event.participants.length;
    let finalMessage = '';

    if (count === 0) {
        finalMessage = '⏰ Время вышло! Никто не пошел на ивент 😢';
    } else {
        let mentionList = '';
        event.participants.forEach((p, index) => {
            const safeName = p.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            mentionList += `<a href="tg://user?id=${p.id}">${safeName}</a>`;
            if (index < count - 1) mentionList += ', ';
        });
        finalMessage = `🔥 **КЛАНОВЫЙ ИВЕНТ НАЧИНАЕТСЯ!** 🔥\n\n⚔️ Пора в бой!\n\n👥 **Список участников (${count}):**\n${mentionList}\n\n⚠️ **ВАЖНОЕ ПРЕДУПРЕЖДЕНИЕ:**\nВсе, кто записался в список выше, обязаны явиться!\n❌ <b>В случае неявки без уважительной причины — обязательный отчет перед администрацией!</b>`;
    }

    index.sendMessage(chatId, finalMessage, { parse_mode: 'HTML' }).catch(err => {
        if (err.response && err.response.body.description.includes('have no rights')) {
            index.sendMessage(chatId, '⚠️ ОШИБКА: Дайте боту права админа для упоминаний!');
        }
    });
}

index.on('polling_error', (error) => {
    console.warn('⚠️ Ошибка сети:', error.code);
});