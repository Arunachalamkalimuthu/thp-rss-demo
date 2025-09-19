FROM node:20-bookworm
WORKDIR /app
COPY app.js .
CMD ["node","--expose-gc","/app/app.js"]
