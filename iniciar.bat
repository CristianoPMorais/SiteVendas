@echo off
title Fred Bot - Diagnostico
color 0a

echo ===================================================
echo       TESTE DE DIAGNOSTICO DO INICIADOR
echo ===================================================
echo.

echo Verificando Node.js...
node -v
if %errorlevel% neq 0 (
    echo [ERRO] Node.js nao encontrado!
    pause
    exit
)

echo.
echo Iniciando o servidor Node.js (Isso vai travar a tela propositalmente)...
echo Pressione CTRL+C se quiser fechar o bot depois.
echo.

:: Inicia o servidor e SEGURA a tela preta aberta para vermos mensagens de erro
node index.js

:: O PAUSE garante que a janela NUNCA feche sozinha
pause