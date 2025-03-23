# Base image
FROM node:18

# Tạo thư mục làm việc bên trong container
WORKDIR /usr/src/app

# Copy file package.json và package-lock.json trước để cache cài lib
COPY package*.json ./

# Cài dependencies
RUN npm install

# Copy toàn bộ mã nguồn
COPY . .

# Chạy app
CMD ["node", "bot.js"]
