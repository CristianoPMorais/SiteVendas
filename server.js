const express = require('express');
const path = require('path');

const app = express();
const PORT = 10000;

// Serve os arquivos estáticos da pasta atual
app.use(express.static(path.join(__dirname)));

app.listen(PORT, () => {
    console.log(`🌐 Site de Vendas rodando independentemente em: http://localhost:${PORT}`);
});