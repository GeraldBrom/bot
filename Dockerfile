# Используем Node.js 24 на базе Alpine
FROM node:24-alpine

WORKDIR /app

# Создаем директорию для данных (БД, логи)
ENV DATA_DIR=/app/data
RUN mkdir -p ${DATA_DIR} && chmod 777 ${DATA_DIR}

# Скрипт entrypoint для прав доступа
RUN echo '#!/bin/sh' > /usr/local/bin/entrypoint.sh && \
    echo 'set -e' >> /usr/local/bin/entrypoint.sh && \
    echo 'mkdir -p ${DATA_DIR}' >> /usr/local/bin/entrypoint.sh && \
    echo 'chmod 777 ${DATA_DIR}' >> /usr/local/bin/entrypoint.sh && \
    echo 'chown -R $(id -u):$(id -g) ${DATA_DIR} 2>/dev/null || true' >> /usr/local/bin/entrypoint.sh && \
    echo 'exec "$@"' >> /usr/local/bin/entrypoint.sh && \
    chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Копируем файлы package.json первыми (для кэширования слоев)
COPY package*.json ./

# --- ДОБАВЛЕНА УСТАНОВКА ЗАВИСИМОСТЕЙ ---
# Устанавливаем основные библиотеки: telegram-bot-api, прокси и dotenv
RUN npm install node-telegram-bot-api https-proxy-agent dotenv

# Если у вас есть package-lock.json, лучше использовать npm ci, но для явной установки пакетов выше подходит npm install
# Альтернатива (если хотите установить ВСЕ зависимости из package.json, а не только эти три):
# RUN npm install --only=production

# Очищаем кеш для уменьшения размера образа
RUN npm cache clean --force || true

# Копируем весь код приложения
COPY . .

EXPOSE 3000

# Запускаем бота (файл bot.js)
CMD ["node", "bot.js"]
