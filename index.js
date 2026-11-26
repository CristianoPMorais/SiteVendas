require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { exec } = require('child_process');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const timestampInicioBot = Math.floor(Date.now() / 1000);

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Caminhos absolutos para garantir leitura/gravação sempre na pasta do projeto
const ARQUIVO_CONFIG = path.join(__dirname, 'config.json');
const ARQUIVO_BLOQUEADOS = path.join(__dirname, 'bloqueados.json');
const ARQUIVO_HISTORICO = path.join(__dirname, 'historicos.json');
const ARQUIVO_LEADS_CAMPANHA = path.join(__dirname, 'leads_campanha.json');

const NOME_COOKIE_SESSAO = 'digitavia_panel_senha';
const SENHA_GERENTE_SERVIDOR = process.env.SENHA_GERENTE || 'DigitaviaAdmin';

const historicosConversas = {};

// Controle para agrupar mensagens rápidas do mesmo contato (Debounce)
const filasMensagensPendentes = {};
const temporizadoresMensagens = {};

let contatosBloqueados = [];
const statusUsuarios = {};
const statusAguardandoHumano = {};
const statusConversasFinalizadas = {};
const gruposPermitidos = [];
const MODELO_IA = 'gemini-3.6-flash';
const MODELOS_FALLBACK = ['gemini-3.6-flash', 'gemini-3.8-flash'];

let donoConectado = null;
const donosFixos = ['556299615120'];
let isBotActiveGlobal = true;
let connectionStatus = 'disconnected';
let currentQRCode = null;
let sockInstance = null;

// =========================================================
// 📣 ESTADO DA CAMPANHA DE DISPARO CONTROLADO
// =========================================================
let estadoCampanha = {
    rodando: false,
    pausada: false,
    enviadosSessao: 0,
    errosSessao: 0,
    ultimoEnvioEm: null,
    mensagemAtual: `{abertura}{nome_virgula} vi a operação de vocês{estabelecimento} e notei como o atendimento no WhatsApp exige agilidade quando o balcão está movimentado.\n\nImplanto um atendente virtual humanizado no WhatsApp (24/7), sem menus de "digite 1 ou 2", que entende texto, áudio e imagem e já organiza o atendimento antes de passar para a equipe.\n\nSe fizer sentido para vocês, posso te mostrar rapidamente como encaixa na rotina da drogaria. Como está o movimento no WhatsApp por aí?`,
    config: {
        delayMinMs: 25000,
        delayMaxMs: 60000,
        loteTamanho: 8,
        pausaLoteMs: 180000,
        maxPorDia: 35,
        apenasHorarioComercial: true,
        variacoesAbertura: [
            'Olá, tudo bem?',
            'Oi, como vão as coisas por aí?',
            'Olá! Passando bem rápido pelo WhatsApp,'
        ]
    }
};

function formatarNumero(numero) {
    return String(numero || '').replace(/\D/g, '');
}

function normalizarJidChave(jid = '') {
    return String(jid).replace(/:\d+@/, '@').trim();
}

function ehGrupoOuBroadcast(jid = '') {
    const s = String(jid || '').toLowerCase().trim();
    return !s || s === 'status@broadcast' || s.endsWith('@g.us') || s.includes('@g.us') || s.includes('@broadcast');
}

function ehNumeroDono(numeroOuJid) {
    const numLimpo = formatarNumero(String(numeroOuJid || '').split('@')[0].split(':')[0]);
    if (!numLimpo) return false;
    return donosFixos.includes(numLimpo) || (donoConectado && numLimpo === donoConectado);
}

function limparAguardandoDoDono() {
    Object.keys(statusAguardandoHumano).forEach((jid) => {
        if (ehNumeroDono(jid)) {
            statusAguardandoHumano[jid] = false;
        }
    });
}

function limparEstadoAguardandoJid(jidAlvo) {
    const alvoNorm = normalizarJidChave(jidAlvo);
    const numAlvo = formatarNumero(String(jidAlvo || '').split('@')[0].split(':')[0]);

    Object.keys(statusAguardandoHumano).forEach((chave) => {
        const chaveNorm = normalizarJidChave(chave);
        const numChave = formatarNumero(String(chave || '').split('@')[0].split(':')[0]);
        if (
            chave === jidAlvo ||
            chaveNorm === alvoNorm ||
            (numAlvo && numChave === numAlvo)
        ) {
            statusAguardandoHumano[chave] = false;
        }
    });
    limparAguardandoDoDono();
}

const configPadrao = {
    nomeAgente: 'Digitavia',
    senhaPainel: '1234',
    apiKey: '',
    systemInstruction: "Você é o assistente virtual da Digitavia. Na primeira mensagem de um novo contato, seja educado, pergunte o nome do cliente (caso não saiba) e o motivo do contato. Assim que souber o nome, passe a chamá-lo pelo nome em todas as respostas seguintes. Coloque no final da mensagem a assinatura: Att.: Assistente Digitavia.",
    comandoLigar: 'digitavia on',
    comandoDesligar: 'digitavia off',
    comandoBloquear: 'bloquear',
    comandoDesbloquear: 'desbloquear',
    comandoVerBloqueados: 'ver bloqueados',
    msgVerBloqueados: '🚫 **Números Bloqueados:**\n\n{lista}',
    apiKeys: []
};

function salvarConfig(novaConfig) {
    try {
        fs.writeFileSync(ARQUIVO_CONFIG, JSON.stringify(novaConfig, null, 2), 'utf8');
    } catch (e) {
        console.error('❌ Erro ao salvar config.json:', e);
    }
}

function carregarConfig() {
    try {
        if (fs.existsSync(ARQUIVO_CONFIG)) {
            const carregada = { ...configPadrao, ...JSON.parse(fs.readFileSync(ARQUIVO_CONFIG, 'utf8')) };
            if (!carregada.senhaPainel || String(carregada.senhaPainel).trim() === '') {
                carregada.senhaPainel = '1234';
                salvarConfig(carregada);
            }
            return carregada;
        }
    } catch (e) {
        console.error('❌ Erro ao ler config.json:', e);
    }
    salvarConfig(configPadrao);
    return { ...configPadrao };
}

let botConfig = carregarConfig();
let indiceChaveAtual = 0;
let ai = null;

function obterSenhaAtual() {
    return String(botConfig?.senhaPainel || '1234');
}

function parseCookies(req) {
    const header = req.headers.cookie || '';
    return header.split(';').reduce((acc, part) => {
        const idx = part.indexOf('=');
        if (idx > -1) {
            acc[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
        }
        return acc;
    }, {});
}

function estaAutenticado(req) {
    const cookies = parseCookies(req);
    const senhaCookie = cookies[NOME_COOKIE_SESSAO];
    return Boolean(senhaCookie && senhaCookie === obterSenhaAtual());
}

function exigirAuthApi(req, res, next) {
    if (estaAutenticado(req)) return next();
    return res.status(401).json({ success: false, error: 'Não autorizado. Faça login com a senha do painel.' });
}

function carregarHistoricoEmDisco() {
    try {
        if (fs.existsSync(ARQUIVO_HISTORICO)) {
            const conteudo = fs.readFileSync(ARQUIVO_HISTORICO, 'utf8').trim();
            if (conteudo) {
                const dados = JSON.parse(conteudo);
                Object.keys(dados).forEach(jid => {
                    if (!ehGrupoOuBroadcast(jid)) {
                        historicosConversas[jid] = dados[jid];
                    }
                });
                console.log(`📂 Histórico carregado com sucesso! Contatos anteriores encontrados: ${Object.keys(historicosConversas).length}`);
            }
        }
    } catch (e) {
        console.error('❌ Erro ao carregar historicos.json:', e);
    }
}

function salvarHistoricoEmDisco() {
    try {
        fs.writeFileSync(ARQUIVO_HISTORICO, JSON.stringify(historicosConversas, null, 2), 'utf8');
    } catch (e) {
        console.error('❌ Erro ao salvar historicos.json:', e);
    }
}

function carregarLeadsCampanha() {
    try {
        if (fs.existsSync(ARQUIVO_LEADS_CAMPANHA)) {
            const raw = fs.readFileSync(ARQUIVO_LEADS_CAMPANHA, 'utf8').trim();
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed : [];
        }
    } catch (e) {
        console.error('❌ Erro ao ler leads_campanha.json:', e);
    }
    return [];
}

function salvarLeadsCampanha(lista) {
    try {
        fs.writeFileSync(ARQUIVO_LEADS_CAMPANHA, JSON.stringify(lista, null, 2), 'utf8');
    } catch (e) {
        console.error('❌ Erro ao salvar leads_campanha.json:', e);
    }
}

function normalizarTelefoneBR(raw) {
    let d = formatarNumero(raw);
    if (!d) return null;
    if (d.startsWith('0')) d = d.slice(1);
    if (d.length === 10 || d.length === 11) {
        d = '55' + d;
    }
    return d.length >= 12 && d.length <= 13 ? d : null;
}

function resumoCampanha() {
    const leads = carregarLeadsCampanha();
    const contadores = {
        total: leads.length,
        pendente: 0,
        enviado: 0,
        erro: 0,
        ignorado: 0,
        sem_whatsapp: 0
    };
    for (const item of leads) {
        const st = item.status || 'pendente';
        if (contadores[st] !== undefined) contadores[st] += 1;
    }
    return {
        ...estadoCampanha,
        contadores,
        leads
    };
}

function obterListaChaves() {
    const chavesEnv = [
        process.env.GEMINI_API_KEYS || '',
        process.env.GEMINI_API_KEY || ''
    ]
        .join(',')
        .split(/[\n,]+/)
        .map(k => k.trim())
        .filter(Boolean);

    const chavesConfig = [];
    if (botConfig.apiKeys && Array.isArray(botConfig.apiKeys)) {
        chavesConfig.push(...botConfig.apiKeys.map(k => String(k).trim()).filter(Boolean));
    }
    if (botConfig.apiKey) {
        chavesConfig.push(String(botConfig.apiKey).trim());
    }

    return [...new Set([...chavesEnv, ...chavesConfig])];
}

function atualizarClienteAI() {
    const chaves = obterListaChaves();
    if (chaves.length === 0) {
        console.error('❌ Nenhuma chave de API configurada!');
        return;
    }
    if (indiceChaveAtual >= chaves.length) {
        indiceChaveAtual = 0;
    }
    const chaveAtiva = chaves[indiceChaveAtual];
    ai = new GoogleGenAI({ apiKey: chaveAtiva });
}

function esperarMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function obterModelosCandidatos(modeloSolicitado) {
    const lista = [modeloSolicitado || MODELO_IA, ...MODELOS_FALLBACK]
        .map(m => String(m || '').trim())
        .filter(Boolean);
    return Array.from(new Set(lista));
}

async function gerarConteudoComRotacao(paramsRequest) {
    const chaves = obterListaChaves();
    if (!chaves || chaves.length === 0) {
        throw new Error('Nenhuma chave de API configurada em apiKeys/apiKey.');
    }

    const modelos = obterModelosCandidatos(paramsRequest.model);
    const maxRodadas = 3;
    let ultimoErro = null;

    for (let rodada = 0; rodada < maxRodadas; rodada++) {
        for (const modeloAtual of modelos) {
            for (let i = 0; i < chaves.length; i++) {
                const idxChave = (indiceChaveAtual + i) % chaves.length;
                indiceChaveAtual = idxChave;

                try {
                    atualizarClienteAI();
                    const response = await ai.models.generateContent({
                        ...paramsRequest,
                        model: modeloAtual
                    });
                    return response;
                } catch (error) {
                    ultimoErro = error;
                    const msgErro = String(error?.message || '');
                    const ehSobrecarga = error?.status === 503 || msgErro.includes('503') || msgErro.includes('UNAVAILABLE') || msgErro.includes('high demand');
                    const ehCota = error?.status === 429 || msgErro.includes('429') || msgErro.includes('RESOURCE_EXHAUSTED');

                    console.warn(`⚠️ Erro com modelo [${modeloAtual}] / chave [${idxChave + 1}/${chaves.length}]: ${msgErro}`);

                    if (chaves.length > 1) {
                        indiceChaveAtual = (idxChave + 1) % chaves.length;
                        if (ehSobrecarga || ehCota) {
                            console.log(`🔄 Alternando automaticamente para a próxima chave da API...`);
                        }
                    }
                }
            }
        }

        if (rodada < maxRodadas - 1) {
            const pausa = 1200 * (rodada + 1);
            await esperarMs(pausa);
        }
    }

    throw ultimoErro || new Error('Todas as chaves e modelos falharam.');
}

function respostaFallbackDigitavia(ultimaPergunta = '') {
    const p = String(ultimaPergunta || '').toLowerCase();
    if (p.includes('especialista') || p.includes('humano') || p.includes('atendente') || p.includes('falar') || p.includes('demo') || p.includes('contato')) {
        return 'Posso conectar você com um especialista da Digitavia agora mesmo. Clique em "Agendar Demo" no topo ou envie seu nome, segmento (Advocacia, Comércio ou Drogaria) e WhatsApp por aqui mesmo que organizamos o atendimento (WhatsApp comercial: (62) 99657-585).';
    }
    if (p.includes('plano') || p.includes('preço') || p.includes('preco') || p.includes('valor')) {
        return 'Os planos mensais da Digitavia são:\n• Start Essencial: R$ 297/mês (1 WhatsApp, 24/7, Command Center básico)\n• Pro Multimodal: R$ 497/mês (1 WhatsApp, ouve áudios e lê fotos, script jurídico/comércio/drogaria, Command Center completo e rotação automática de chaves)\n• Business Scale: R$ 897/mês (até 3 números, recursos do Pro e base de conhecimento em PDFs).';
    }
    if (p.includes('prazo') || p.includes('implant') || p.includes('demora')) {
        return 'A implantação assistida pela Digitavia leva até 48 horas após o alinhamento, mantendo seu número atual de WhatsApp via QR Code.';
    }
    return 'Estou online como assistente da Digitavia. Posso detalhar os planos (Start Essencial, Pro Multimodal e Business Scale), explicar como funciona a triagem por áudio/foto e transbordo humano no WhatsApp, ou encaminhar você para um especialista.';
}

// =========================================================
// 🌐 ROTA /api/gemini PARA O CHAT WEB DA DIGITAVIA
// =========================================================
app.post('/api/gemini', async (req, res) => {
    const { systemInstruction, contents, keyIndex } = req.body || {};
    const chaves = obterListaChaves();
    const safeContents = Array.isArray(contents) && contents.length > 0
        ? contents
        : [{ role: 'user', parts: [{ text: 'Olá' }] }];
app.post('/api/transbordo-web', async (req, res) => {
    const { nome, segmento, telefone, necessidade, historico } = req.body || {};
    const numLimpo = formatarNumero(telefone);
    const destinoWhatsapp = '556299615120';

    const resumoHist = Array.isArray(historico)
        ? historico
            .slice(-6)
            .map(m => `${m.role === 'user' ? 'Visitante' : 'Digitavia'}: ${m.parts?.map(p => p.text || '').join(' ')}`)
            .join('\n')
        : '';

    const textoAlerta = [
        '🔔 *NOVO ATENDIMENTO AGUARDANDO HUMANO (CHAT DO SITE)*',
        `👤 *Nome:* ${nome || 'Não informado'}`,
        `🏢 *Segmento:* ${segmento || 'Não informado'}`,
        `📱 *WhatsApp informado:* ${numLimpo || telefone || 'Não informado'}`,
        `📝 *Contexto:* ${necessidade || 'Solicitou atendente no chat'}`,
        resumoHist ? `\n💬 *Últimas mensagens:*\n${resumoHist}` : ''
    ].join('\n').trim();

    let enviadoWhatsapp = false;
    if (sockInstance && connectionStatus === 'open') {
        try {
            await sockInstance.sendMessage(`${destinoWhatsapp}@s.whatsapp.net`, { text: textoAlerta });
            enviadoWhatsapp = true;
        } catch (err) {
            console.error('❌ Erro ao enviar alerta do chat web no WhatsApp:', err.message);
        }
    }

    const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    io.emit('new_message', {
        sender: numLimpo || 'Site-Chat',
        text: `[Transbordo Site] ${nome || 'Visitante'} (${segmento || '-'}) - ${numLimpo || telefone || '-'}`,
        time: hora
    });

    res.json({ success: true, enviadoWhatsapp });
});

    const ultimaMensagemUsuario = [...safeContents]
        .reverse()
        .find(m => m?.role === 'user')
        ?.parts?.map(pt => pt?.text || '')
        .join(' ') || '';

    if (typeof keyIndex === 'number' && keyIndex >= 0 && chaves.length > 0) {
        indiceChaveAtual = keyIndex % chaves.length;
    }

    if (chaves.length === 0) {
        return res.json({
            text: respostaFallbackDigitavia(ultimaMensagemUsuario),
            totalKeys: 0,
            source: 'fallback-sem-chave'
        });
    }

    try {
        const resposta = await gerarConteudoComRotacao({
            model: MODELO_IA,
            contents: safeContents,
            ...(systemInstruction ? { config: { systemInstruction: String(systemInstruction) } } : {})
        });
        const texto = String(resposta?.text || '').trim();
        if (texto) {
            return res.json({
                text: texto,
                totalKeys: chaves.length,
                slotUsed: (indiceChaveAtual % chaves.length) + 1
            });
        }
    } catch (_) {
        // Fallback abaixo
    }

    return res.json({
        text: respostaFallbackDigitavia(ultimaMensagemUsuario),
        totalKeys: chaves.length,
        source: 'fallback-apos-rotacao'
    });
});

function carregarBloqueados() {
    try {
        if (fs.existsSync(ARQUIVO_BLOQUEADOS)) {
            const conteudo = fs.readFileSync(ARQUIVO_BLOQUEADOS, 'utf8').trim();
            return conteudo ? JSON.parse(conteudo) : [];
        }
    } catch (error) {
        console.error('❌ Erro ao ler bloqueados.json:', error);
    }
    return [];
}

function salvarBloqueados(lista) {
    try {
        fs.writeFileSync(ARQUIVO_BLOQUEADOS, JSON.stringify(lista, null, 2), 'utf8');
    } catch (error) {
        console.error('❌ Erro ao salvar bloqueados.json:', error);
    }
}

contatosBloqueados = carregarBloqueados();

function bloquearClienteAutomaticamentePorEnvioDono(senderJid, numeroAlvo, motivo = 'Mensagem enviada pelo dono na conversa') {
    if (ehGrupoOuBroadcast(senderJid)) return false;

    const numLimpo = formatarNumero(numeroAlvo || String(senderJid || '').split('@')[0].split(':')[0]);
    if (!numLimpo) return false;
    if (ehNumeroDono(numLimpo) || ehNumeroDono(senderJid)) return false;

    statusUsuarios[senderJid] = false;
    statusAguardandoHumano[senderJid] = false;

    let alterou = false;
    if (!contatosBloqueados.includes(numLimpo)) {
        contatosBloqueados.push(numLimpo);
        salvarBloqueados(contatosBloqueados);
        alterou = true;
        console.log(`🚫 Bloqueio automático ativado para ${numLimpo} (${motivo}).`);
    }

    updateClients();
    return alterou;
}

function obterSaudacao() {
    const hora = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false });
    const h = parseInt(hora, 10);
    if (h >= 6 && h < 12) return 'Bom dia';
    if (h >= 12 && h < 18) return 'Boa tarde';
    return 'Boa noite';
}

function obterDataHoraAtual() {
    const agora = new Date();
    const dataFormatada = agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const horaFormatada = agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return { dataFormatada, horaFormatada };
}

function dentroHorarioComercialSP() {
    const hora = parseInt(
        new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }),
        10
    );
    return hora >= 8 && hora < 19;
}

function delayAleatorioMs(minMs, maxMs) {
    const min = Math.max(5000, Number(minMs) || 25000);
    const max = Math.max(min + 1000, Number(maxMs) || 60000);
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function montarMensagemVariada(lead, templateBase) {
    const aberturas = estadoCampanha.config.variacoesAbertura || ['Olá, tudo bem?'];
    const abertura = aberturas[Math.floor(Math.random() * aberturas.length)].trim();
    const nomeLimpo = String(lead.nome || '').trim();
    const estabLimpo = String(lead.estabelecimento || '').trim();

    const aberturaSemPontuacaoFinal = abertura.replace(/[,?!.]+$/g, '').trim();
    const nomeComVirgula = nomeLimpo
        ? (/[?!.]$/.test(abertura) ? ` ${nomeLimpo},` : ` ${nomeLimpo},`)
        : '';
    const nomeSimples = nomeLimpo ? ` ${nomeLimpo}` : '';
    const estabTexto = estabLimpo ? ` da ${estabLimpo}` : '';

    let texto = String(templateBase || '')
        .replace(/\{abertura\}/gi, abertura)
        .replace(/\{abertura_sem_pontuacao\}/gi, aberturaSemPontuacaoFinal)
        .replace(/\{nome_virgula\}/gi, nomeComVirgula)
        .replace(/\{nome\}/gi, nomeSimples)
        .replace(/\{estabelecimento\}/gi, estabTexto)
        .replace(/\s{2,}/g, ' ')
        .trim();

    if (!/\{abertura\}|\{abertura_sem_pontuacao\}/i.test(templateBase || '')) {
        texto = `${abertura} ${texto}`.trim();
    }

    return texto;
}

async function executarCampanhaSegura() {
    if (estadoCampanha.rodando) return;
    estadoCampanha.rodando = true;
    estadoCampanha.pausada = false;
    estadoCampanha.enviadosSessao = 0;
    estadoCampanha.errosSessao = 0;
    updateClients();

    let leads = carregarLeadsCampanha();

    try {
        for (let i = 0; i < leads.length; i++) {
            if (!estadoCampanha.rodando) break;

            while (estadoCampanha.pausada && estadoCampanha.rodando) {
                await esperarMs(2000);
            }
            if (!estadoCampanha.rodando) break;

            if (estadoCampanha.enviadosSessao >= Number(estadoCampanha.config.maxPorDia || 35)) {
                console.log('🛑 Limite diário de disparos da campanha atingido.');
                break;
            }

            if (estadoCampanha.config.apenasHorarioComercial && !dentroHorarioComercialSP()) {
                console.log('🕒 Campanha aguardando horário comercial (08h-19h)...');
                await esperarMs(60000);
                i--;
                continue;
            }

            leads = carregarLeadsCampanha();
            const lead = leads[i];
            if (!lead) continue;
            if (lead.status === 'enviado' || lead.status === 'ignorado' || lead.status === 'sem_whatsapp') continue;

            const numeroLimpo = normalizarTelefoneBR(lead.numero);
            if (!numeroLimpo || ehNumeroDono(numeroLimpo) || contatosBloqueados.includes(numeroLimpo)) {
                lead.status = 'ignorado';
                salvarLeadsCampanha(leads);
                updateClients();
                continue;
            }

            if (!sockInstance || connectionStatus !== 'open') {
                console.log('⚠️ WhatsApp desconectado. Campanha aguardando reconexão...');
                await esperarMs(5000);
                i--;
                continue;
            }

            const jid = `${numeroLimpo}@s.whatsapp.net`;

            try {
                const [check] = await sockInstance.onWhatsApp(jid);
                if (!check || !check.exists) {
                    lead.status = 'sem_whatsapp';
                    salvarLeadsCampanha(leads);
                    updateClients();
                    continue;
                }

                const textoFinal = montarMensagemVariada(lead, estadoCampanha.mensagemAtual);

                await sockInstance.presenceSubscribe(jid).catch(() => {});
                await sockInstance.sendPresenceUpdate('composing', jid).catch(() => {});
                await esperarMs(Math.floor(Math.random() * 2500) + 1500);
                await sockInstance.sendPresenceUpdate('paused', jid).catch(() => {});

                await sockInstance.sendMessage(jid, { text: textoFinal });

                const horaEnvio = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                lead.status = 'enviado';
                lead.enviadoEm = new Date().toISOString();
                estadoCampanha.enviadosSessao += 1;
                estadoCampanha.ultimoEnvioEm = horaEnvio;

                if (!historicosConversas[jid]) historicosConversas[jid] = [];
                historicosConversas[jid].push({
                    role: 'model',
                    parts: [{ text: textoFinal }],
                    sender: 'assistente',
                    time: horaEnvio
                });
                salvarHistoricoEmDisco();
                salvarLeadsCampanha(leads);
                io.emit('new_message', { sender: numeroLimpo, text: `[Campanha] ${textoFinal}`, time: horaEnvio });
                updateClients();

                const loteTam = Math.max(1, Number(estadoCampanha.config.loteTamanho) || 8);
                if (estadoCampanha.enviadosSessao % loteTam === 0) {
                    const pausaLote = Math.max(10000, Number(estadoCampanha.config.pausaLoteMs) || 180000);
                    console.log(`⏸️ Lote de ${loteTam} envios concluído. Pausando por ${Math.round(pausaLote / 1000)}s...`);
                    await esperarMs(pausaLote);
                } else {
                    const espera = delayAleatorioMs(estadoCampanha.config.delayMinMs, estadoCampanha.config.delayMaxMs);
                    console.log(`⏳ Próximo envio da campanha em ${Math.round(espera / 1000)}s...`);
                    await esperarMs(espera);
                }
            } catch (err) {
                lead.status = 'erro';
                lead.erroMsg = String(err?.message || err);
                estadoCampanha.errosSessao += 1;
                salvarLeadsCampanha(leads);
                updateClients();
                console.error(`❌ Erro ao disparar para ${numeroLimpo}:`, err.message);
                await esperarMs(15000);
            }
        }
    } finally {
        estadoCampanha.rodando = false;
        estadoCampanha.pausada = false;
        updateClients();
    }
}

function updateClients() {
    limparAguardandoDoDono();
    const totalAtivas = Object.keys(historicosConversas).filter(jid => !ehGrupoOuBroadcast(jid) && !statusConversasFinalizadas[jid]).length;
    const totalAguardando = Object.values(statusAguardandoHumano).filter(v => v === true).length;
    const totalFinalizadas = Object.values(statusConversasFinalizadas).filter(v => v === true).length;

    io.emit('bot_status', {
        isBotActiveGlobal,
        connectionStatus,
        qrCode: currentQRCode,
        statusUsuarios,
        statusAguardandoHumano,
        statusConversasFinalizadas,
        contatosBloqueados,
        totalConversas: totalAtivas,
        totalAguardando,
        totalFinalizadas,
        gruposPermitidos,
        modeloIa: MODELO_IA,
        campanha: resumoCampanha(),
        botConfig: {
            nomeAgente: botConfig.nomeAgente,
            senhaPainel: obterSenhaAtual(),
            systemInstruction: botConfig.systemInstruction,
            comandoLigar: botConfig.comandoLigar,
            comandoDesligar: botConfig.comandoDesligar,
            comandoBloquear: botConfig.comandoBloquear,
            comandoDesbloquear: botConfig.comandoDesbloquear,
            comandoVerBloqueados: botConfig.comandoVerBloqueados,
            msgVerBloqueados: botConfig.msgVerBloqueados,
            apiKeyDefinida: Boolean(obterListaChaves().length > 0)
        }
    });
}

function senhaCorreta(digitada, esperada) {
    try {
        const a = Buffer.from(String(digitada || ''), 'utf8');
        const b = Buffer.from(String(esperada || ''), 'utf8');
        if (a.length !== b.length || a.length === 0) return false;
        return crypto.timingSafeEqual(a, b);
    } catch (_) {
        return false;
    }
}

// =========================================================
// 🔐 ROTAS DE AUTENTICAÇÃO E CAMPANHA
// =========================================================
app.get('/api/auth/status', (req, res) => {
    res.json({ authenticated: estaAutenticado(req) });
});

app.get('/api/config', exigirAuthApi, (req, res) => {
    res.sendFile(path.join(__dirname, 'config.json'));
});

app.get('/api/historicos', exigirAuthApi, (req, res) => {
    res.sendFile(path.join(__dirname, 'historicos.json'));
});

app.post('/api/auth/gerente', exigirAuthApi, (req, res) => {
    const { senha } = req.body || {};
    if (senhaCorreta(senha, SENHA_GERENTE_SERVIDOR)) {
        return res.json({ success: true });
    }
    return res.status(401).json({ success: false, error: 'Senha inválida.' });
});

app.post('/api/auth/login', (req, res) => {
    const { senha } = req.body || {};
    if (String(senha || '') !== obterSenhaAtual()) {
        return res.status(401).json({ success: false, error: 'Senha incorreta.' });
    }
    res.cookie(NOME_COOKIE_SESSAO, obterSenhaAtual(), {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 * 7
    });
    return res.json({ success: true });
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie(NOME_COOKIE_SESSAO);
    return res.json({ success: true });
});

app.get('/api/campanha/status', exigirAuthApi, (req, res) => {
    res.json({ success: true, campanha: resumoCampanha() });
});

app.post('/api/campanha/leads', exigirAuthApi, (req, res) => {
    const { leads, substituir = false } = req.body || {};
    if (!Array.isArray(leads)) {
        return res.status(400).json({ success: false, error: 'Envie um array de leads.' });
    }

    const baseAtual = substituir ? [] : carregarLeadsCampanha();
    const mapa = new Map(baseAtual.map(l => [normalizarTelefoneBR(l.numero), l]));

    for (const rawLead of leads) {
        const num = normalizarTelefoneBR(rawLead.numero || rawLead.telefone || rawLead.whatsapp);
        if (!num || ehNumeroDono(num)) continue;

        const dist = rawLead.distancia_km !== undefined && rawLead.distancia_km !== '' ? Number(rawLead.distancia_km) : null;
        const anterior = mapa.get(num);
        mapa.set(num, {
            nome: String(rawLead.nome || anterior?.nome || '').trim(),
            estabelecimento: String(rawLead.estabelecimento || anterior?.estabelecimento || '').trim(),
            bairro: String(rawLead.bairro || anterior?.bairro || '').trim(),
            cidade: String(rawLead.cidade || anterior?.cidade || 'Goiânia').trim(),
            distancia_km: dist !== null && !Number.isNaN(dist) ? dist : (anterior?.distancia_km ?? null),
            numero: num,
            status: anterior?.status === 'enviado' ? 'enviado' : (rawLead.status || anterior?.status || 'pendente'),
            enviadoEm: anterior?.enviadoEm || null
        });
    }

    const listaFinal = Array.from(mapa.values());
    salvarLeadsCampanha(listaFinal);
    updateClients();
    res.json({ success: true, campanha: resumoCampanha() });
});

app.post('/api/campanha/iniciar', exigirAuthApi, (req, res) => {
    const { mensagem, config } = req.body || {};
    if (mensagem && String(mensagem).trim()) {
        estadoCampanha.mensagemAtual = String(mensagem).trim();
    }
    if (config && typeof config === 'object') {
        estadoCampanha.config = {
            ...estadoCampanha.config,
            ...config
        };
    }

    if (!estadoCampanha.rodando) {
        executarCampanhaSegura();
    } else {
        estadoCampanha.pausada = false;
        updateClients();
    }
    res.json({ success: true, campanha: resumoCampanha() });
});

app.post('/api/campanha/pausar', exigirAuthApi, (req, res) => {
    if (!estadoCampanha.rodando) {
        return res.json({ success: true, campanha: resumoCampanha() });
    }
    estadoCampanha.pausada = !estadoCampanha.pausada;
    updateClients();
    res.json({ success: true, campanha: resumoCampanha() });
});

app.post('/api/campanha/parar', exigirAuthApi, (req, res) => {
    estadoCampanha.rodando = false;
    estadoCampanha.pausada = false;
    updateClients();
    res.json({ success: true, campanha: resumoCampanha() });
});

app.get('/api/status', exigirAuthApi, (req, res) => {
    limparAguardandoDoDono();
    const conversasUnicasMap = {};

    Object.keys(historicosConversas).forEach(jid => {
        if (ehGrupoOuBroadcast(jid)) return;

        const rawId = jid.split('@')[0].split(':')[0];
        let numeroLimpo = rawId.replace(/[^0-9]/g, '');

        if (jid.includes('@lid') && numeroLimpo.length > 15) {
            numeroLimpo = `Contato (${numeroLimpo.slice(-6)})`;
        }

        if (!conversasUnicasMap[jid]) {
            let displayContact = numeroLimpo;
            if (numeroLimpo === donoConectado || donosFixos.includes(numeroLimpo)) {
                displayContact = `${numeroLimpo} (Dono)`;
            }

            let estadoTexto = 'Ativo (IA)';
            if (statusConversasFinalizadas[jid]) {
                estadoTexto = 'Finalizada';
            } else if (statusAguardandoHumano[jid]) {
                estadoTexto = 'Aguardando Humano';
            } else if (statusUsuarios[jid] === false) {
                estadoTexto = 'Pausado (Individual)';
            }

            conversasUnicasMap[jid] = {
                cliente: displayContact,
                jidOriginal: jid,
                status: estadoTexto,
                messages: []
            };
        }

        const msgs = historicosConversas[jid] || [];
        const msgsFormatadas = msgs.map(m => {
            let textoMsg = '';
            if (m.parts && m.parts[0] && m.parts[0].text) {
                textoMsg = m.parts[0].text;
            } else if (m.text) {
                textoMsg = m.text;
            }

            let remetente = m.role === 'user' ? 'cliente' : 'assistente';
            if (m.sender) remetente = m.sender;

            return {
                sender: remetente,
                text: textoMsg,
                time: m.time || new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
            };
        });

        conversasUnicasMap[jid].messages = msgsFormatadas;
    });

    const totalAtivasCount = Object.keys(historicosConversas).filter(jid => !ehGrupoOuBroadcast(jid) && !statusConversasFinalizadas[jid]).length;
    const totalAguardando = Object.values(statusAguardandoHumano).filter(v => v === true).length;
    const totalFinalizadas = Object.values(statusConversasFinalizadas).filter(v => v === true).length;

    res.json({
        active: isBotActiveGlobal,
        connection: connectionStatus,
        conversasAtivasCount: totalAtivasCount,
        numerosIgnoradosCount: contatosBloqueados.length,
        totalAguardando,
        totalFinalizadas,
        contatosBloqueados,
        statusUsuarios,
        statusAguardandoHumano,
        statusConversasFinalizadas,
        modeloIa: MODELO_IA,
        campanha: resumoCampanha(),
        botConfig: {
            nomeAgente: botConfig.nomeAgente,
            senhaPainel: obterSenhaAtual(),
            systemInstruction: botConfig.systemInstruction,
            comandoLigar: botConfig.comandoLigar,
            comandoDesligar: botConfig.comandoDesligar,
            comandoBloquear: botConfig.comandoBloquear,
            comandoDesbloquear: botConfig.comandoDesbloquear,
            comandoVerBloqueados: botConfig.comandoVerBloqueados,
            msgVerBloqueados: botConfig.msgVerBloqueados,
            apiKeyDefinida: Boolean(obterListaChaves().length > 0)
        },
        detalhes: { conversasAtivas: Object.values(conversasUnicasMap) }
    });
});

app.post('/api/send-message', exigirAuthApi, async (req, res) => {
    const { jid, message } = req.body || {};
    if (!sockInstance || !jid || !message || ehGrupoOuBroadcast(jid)) {
        return res.status(400).json({ success: false, error: 'Parâmetros inválidos, grupo ou desconectado.' });
    }

    try {
        await sockInstance.sendMessage(jid, { text: message });
        if (!historicosConversas[jid]) historicosConversas[jid] = [];
        historicosConversas[jid].push({
            role: 'model',
            parts: [{ text: message }],
            sender: 'assistente',
            time: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        });
        salvarHistoricoEmDisco();
        bloquearClienteAutomaticamentePorEnvioDono(jid, formatarNumero(jid.split('@')[0]), 'Mensagem enviada pelo dono via painel');
        updateClients();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/limpar-aguardando', exigirAuthApi, (req, res) => {
    const { jid } = req.body || {};
    if (!jid) return res.status(400).json({ success: false });
    limparEstadoAguardandoJid(jid);
    updateClients();
    res.json({ success: true });
});

async function connectToWhatsApp() {
    connectionStatus = 'connecting';
    updateClients();

    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info_baileys'));
    const sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }) });
    sockInstance = sock;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            currentQRCode = qr;
            connectionStatus = 'qr_ready';
            qrcode.generate(qr, { small: true });
            updateClients();
        }

        if (connection === 'close') {
            currentQRCode = null;
            connectionStatus = 'disconnected';
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            updateClients();
            if (shouldReconnect) setTimeout(() => connectToWhatsApp(), 3000);
        } else if (connection === 'open') {
            currentQRCode = null;
            connectionStatus = 'open';

            if (sock.user && sock.user.id) {
                donoConectado = formatarNumero(sock.user.id.split('@')[0].split(':')[0]);
                console.log(`🤖 Agente ${botConfig.nomeAgente} conectado ao WhatsApp! Dono atual: ${donoConectado}`);
            } else {
                console.log(`🤖 Agente ${botConfig.nomeAgente} conectado ao WhatsApp!`);
            }

            limparAguardandoDoDono();
            updateClients();
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg || !msg.message) return;

        const mensagemTimestamp = Number(msg.messageTimestamp || 0);
        const eMensagemAntiga = mensagemTimestamp > 0 && mensagemTimestamp < timestampInicioBot;

        let sender = msg.key.remoteJid;
        if (ehGrupoOuBroadcast(sender)) return;

        if (sender.includes('@lid')) {
            if (msg.key.participant && msg.key.participant.includes('@s.whatsapp.net')) {
                sender = msg.key.participant;
            } else if (msg.participant && msg.participant.includes('@s.whatsapp.net')) {
                sender = msg.participant;
            } else {
                const remoteJidAlt = msg.key.remoteJidAlt || msg.remoteJidAlt;
                if (remoteJidAlt && remoteJidAlt.includes('@s.whatsapp.net')) {
                    sender = remoteJidAlt;
                }
            }
        }

        if (ehGrupoOuBroadcast(sender)) return;

        const nomeContatoPerfil = (!msg.key.fromMe && msg.pushName) ? msg.pushName.trim() : "";

        const msgType = Object.keys(msg.message)[0];
        let messageText = msg.message.conversation
            || msg.message.extendedTextMessage?.text
            || msg.message.imageMessage?.caption
            || msg.message.videoMessage?.caption
            || '';

        let fileBuffer = null;
        let mimeType = '';

        if (msgType === 'imageMessage') {
            mimeType = msg.message.imageMessage.mimetype || 'image/jpeg';
            if (!messageText) messageText = "[Imagem recebida]";
            try {
                fileBuffer = await downloadMediaMessage(msg, 'buffer', {});
            } catch (err) {
                console.error('❌ Erro ao baixar imagem:', err);
            }
        } else if (msgType === 'audioMessage' || (msgType === 'documentMessage' && msg.message.documentMessage.mimetype?.includes('audio'))) {
            mimeType = msg.message.audioMessage?.mimetype || msg.message.documentMessage?.mimetype || 'audio/ogg; codecs=opus';
            messageText = "[O cliente enviou uma mensagem de áudio/voz]";
            try {
                fileBuffer = await downloadMediaMessage(msg, 'buffer', {});
            } catch (err) {
                console.error('❌ Erro ao baixar áudio:', err);
            }
        }

        if (!messageText && !fileBuffer) return;

        const rawSender = sender.split('@')[0].split(':')[0];
        const senderNumber = formatarNumero(rawSender);

        if (msg.key.fromMe) {
            const textoCru = String(messageText || '').trim().toLowerCase();
            const cmdLigarAtual = String(botConfig.comandoLigar || 'digitavia on').trim().toLowerCase();
            const cmdDesligarAtual = String(botConfig.comandoDesligar || 'digitavia off').trim().toLowerCase();
            const cmdDesbloquearAtual = String(botConfig.comandoDesbloquear || 'desbloquear').trim().toLowerCase();
            const cmdVerBloqAtual = String(botConfig.comandoVerBloqueados || 'ver bloqueados').trim().toLowerCase();

            const ehComandoControleDono =
                textoCru === cmdLigarAtual ||
                textoCru === 'digitavia on' ||
                textoCru === 'digitavia-on' ||
                textoCru === cmdDesligarAtual ||
                textoCru === 'digitavia off' ||
                textoCru === 'digitavia-off' ||
                (cmdDesbloquearAtual && textoCru.startsWith(cmdDesbloquearAtual)) ||
                (cmdVerBloqAtual && textoCru.includes(cmdVerBloqAtual));

            if (!ehComandoControleDono) {
                bloquearClienteAutomaticamentePorEnvioDono(sender, senderNumber, 'Dono enviou mensagem na conversa');
            }
        }

        if (!filasMensagensPendentes[sender]) {
            filasMensagensPendentes[sender] = [];
        }

        filasMensagensPendentes[sender].push({
            text: messageText,
            fileBuffer,
            mimeType,
            msg,
            senderNumber,
            nomeContatoPerfil,
            eMensagemAntiga
        });

        if (temporizadoresMensagens[sender]) {
            clearTimeout(temporizadoresMensagens[sender]);
        }

        temporizadoresMensagens[sender] = setTimeout(async () => {
            const mensagensAcumuladas = filasMensagensPendentes[sender];
            delete filasMensagensPendentes[sender];
            delete temporizadoresMensagens[sender];

            if (!mensagensAcumuladas || mensagensAcumuladas.length === 0) return;

            const textoCombinado = mensagensAcumuladas.map(m => m.text).filter(Boolean).join('\n');
            const ultimaItem = mensagensAcumuladas[mensagensAcumuladas.length - 1];
            const arquivoFinal = mensagensAcumuladas.find(m => m.fileBuffer)?.fileBuffer || null;
            const mimeFinal = mensagensAcumuladas.find(m => m.fileBuffer)?.mimeType || '';

            await processarMensagemUnificada(
                sock,
                ultimaItem.msg,
                sender,
                ultimaItem.senderNumber,
                textoCombinado,
                arquivoFinal,
                mimeFinal,
                ultimaItem.nomeContatoPerfil,
                ultimaItem.eMensagemAntiga
            );
        }, 3000);
    });
}

async function processarMensagemUnificada(sock, msg, sender, senderNumber, messageText, fileBuffer, mimeType, nomeContatoPerfil, eMensagemAntiga) {
    if (ehGrupoOuBroadcast(sender)) return;

    const isOwner = (donoConectado && senderNumber === donoConectado) || donosFixos.includes(senderNumber) || msg.key.fromMe;

    if (isOwner || ehNumeroDono(senderNumber) || ehNumeroDono(sender)) {
        statusAguardandoHumano[sender] = false;
        limparAguardandoDoDono();
    }

    if (statusUsuarios[sender] === undefined) statusUsuarios[sender] = true;

    const cleanTextInicial = String(messageText || '').trim().toLowerCase();
    const cmdLigarInd = String(botConfig.comandoLigar || 'digitavia on').trim().toLowerCase();
    const cmdLigarAlt1 = `${String(botConfig.nomeAgente || 'digitavia').toLowerCase()}-on`;
    const cmdLigarAlt2 = 'digitavia-on';
    const ehComandoLigar = cleanTextInicial === cmdLigarInd || cleanTextInicial === cmdLigarAlt1 || cleanTextInicial === cmdLigarAlt2;

    if ((!isBotActiveGlobal || !statusUsuarios[sender] || statusConversasFinalizadas[sender]) && !isOwner && !ehComandoLigar) {
        return;
    }

    if (fileBuffer && mimeType && mimeType.includes('audio') && !eMensagemAntiga) {
        try {
            const respTranscricao = await gerarConteudoComRotacao({
                model: MODELO_IA,
                contents: [{
                    role: 'user',
                    parts: [
                        { inlineData: { data: fileBuffer.toString('base64'), mimeType } },
                        { text: 'Transcreva exatamente o que foi dito neste áudio em português, sem comentários extras.' }
                    ]
                }]
            });
            const transcricao = respTranscricao.text?.trim();
            if (transcricao) {
                messageText = `${messageText}\n[Transcrição do áudio]: ${transcricao}`;
            }
        } catch (err) {
            console.warn('⚠️ Falha ao transcrever áudio:', err.message);
        }
    }

    const cleanText = String(messageText || '').trim().toLowerCase();
    const horaMensagem = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    if (!historicosConversas[sender]) historicosConversas[sender] = [];

    const remetenteMsg = msg.key.fromMe ? 'assistente' : 'cliente';
    const ultimaArmazenada = historicosConversas[sender][historicosConversas[sender].length - 1];
    const textoUltima = ultimaArmazenada?.parts?.[0]?.text || ultimaArmazenada?.text;

    if (!ultimaArmazenada || textoUltima !== messageText || ultimaArmazenada.sender !== remetenteMsg) {
        historicosConversas[sender].push({
            role: msg.key.fromMe ? 'model' : 'user',
            parts: [{ text: messageText }],
            sender: remetenteMsg,
            time: horaMensagem
        });
        salvarHistoricoEmDisco();
        io.emit('new_message', { sender: senderNumber, text: messageText, time: horaMensagem });
        updateClients();
    }

    if (eMensagemAntiga && !msg.key.fromMe) {
        return;
    }

    if (contatosBloqueados.includes(senderNumber) && !ehComandoLigar && !isOwner) {
        return;
    }

    const cmdVerBloqueados = String(botConfig.comandoVerBloqueados || 'ver bloqueados').trim().toLowerCase();
    const cmdPersonalizadoMatch = cleanText.includes(cmdVerBloqueados);
    const cmdVariacoesMatch = cleanText.includes('ver boqueado') || cleanText.includes('lista bloqueado');

    if ((cmdPersonalizadoMatch || cmdVariacoesMatch) && isOwner) {
        if (contatosBloqueados.length === 0) {
            await sock.sendMessage(sender, { text: `📋 Nenhum número bloqueado no momento.` });
        } else {
            const lista = contatosBloqueados.map((num, index) => `${index + 1}. ${num}`).join('\n');
            const templateMsg = botConfig.msgVerBloqueados || '🚫 **Números Bloqueados:**\n\n{lista}';
            const mensagemFinal = templateMsg.replace('{lista}', lista);
            await sock.sendMessage(sender, { text: mensagemFinal });
        }
        return;
    }

    if (isOwner) {
        const cmdBloquear = String(botConfig.comandoBloquear || 'bloquear').trim().toLowerCase();
        const cmdDesbloquear = String(botConfig.comandoDesbloquear || 'desbloquear').trim().toLowerCase();
        const cmdDesligarGlobal = String(botConfig.comandoDesligar || 'digitavia off').trim().toLowerCase();
        const cmdLigarGlobal = String(botConfig.comandoLigar || 'digitavia on').trim().toLowerCase();

        if (cmdDesbloquear && cleanText.startsWith(cmdDesbloquear)) {
            const numeroExtraido = cleanText.slice(cmdDesbloquear.length).trim();
            const num = formatarNumero(numeroExtraido);

            if (num) {
                contatosBloqueados = contatosBloqueados.filter(n => n !== num);
                salvarBloqueados(contatosBloqueados);
                updateClients();
                await sock.sendMessage(sender, { text: `✅ Número ${num} desbloqueado com sucesso!` });
            }
            return;
        } else if (cmdBloquear && cleanText.startsWith(cmdBloquear)) {
            const numeroExtraido = cleanText.slice(cmdBloquear.length).trim();
            const num = formatarNumero(numeroExtraido);

            if (num && (num === donoConectado || donosFixos.includes(num))) {
                await sock.sendMessage(sender, { text: `⚠️ Ação negada: Não é permitido bloquear o número do proprietário do sistema.` });
                return;
            }

            if (num && !contatosBloqueados.includes(num)) {
                contatosBloqueados.push(num);
                salvarBloqueados(contatosBloqueados);
                updateClients();
                await sock.sendMessage(sender, { text: `🚫 Número ${num} adicionado para não interação com o bot!` });
            } else {
                const chatAlvo = formatarNumero(sender.split('@')[0]);

                if (chatAlvo && chatAlvo !== donoConectado && !donosFixos.includes(chatAlvo) && !contatosBloqueados.includes(chatAlvo)) {
                    contatosBloqueados.push(chatAlvo);
                    salvarBloqueados(contatosBloqueados);
                    updateClients();
                    await sock.sendMessage(sender, { text: `🚫 Este chat (${chatAlvo}) foi bloqueado com sucesso!` });
                } else if (chatAlvo === donoConectado || donosFixos.includes(chatAlvo)) {
                    await sock.sendMessage(sender, { text: `⚠️ Ação negada: Você não pode bloquear o seu próprio chat de administrador.` });
                }
            }
            return;
        }

        if (cleanText === cmdDesligarGlobal) {
            isBotActiveGlobal = false;
            const textoResposta = `😴 ${botConfig.nomeAgente} desativado GLOBALMENTE.`;
            await sock.sendMessage(sender, { text: textoResposta });

            historicosConversas[sender].push({
                role: 'model',
                parts: [{ text: textoResposta }],
                sender: 'assistente',
                time: horaMensagem
            });
            salvarHistoricoEmDisco();
            updateClients();
            return;
        }

        if (cleanText === cmdLigarGlobal) {
            isBotActiveGlobal = true;
            const textoResposta = `🤖 ${botConfig.nomeAgente} ativado GLOBALMENTE!`;
            await sock.sendMessage(sender, { text: textoResposta });

            historicosConversas[sender].push({
                role: 'model',
                parts: [{ text: textoResposta }],
                sender: 'assistente',
                time: horaMensagem
            });
            salvarHistoricoEmDisco();
            updateClients();
            return;
        }

        if (msg.key.fromMe) {
            bloquearClienteAutomaticamentePorEnvioDono(sender, senderNumber, 'Mensagem registrada como fromMe');
            return;
        }
    }

    if (ehComandoLigar) {
        statusUsuarios[sender] = true;
        statusAguardandoHumano[sender] = false;
        statusConversasFinalizadas[sender] = false;

        contatosBloqueados = contatosBloqueados.filter(n => n !== senderNumber);
        salvarBloqueados(contatosBloqueados);

        const msgAtivado = `🤖 ${botConfig.nomeAgente} ativado para você! Como posso ajudar?`;
        await sock.sendMessage(sender, { text: msgAtivado });
        historicosConversas[sender].push({ role: 'model', parts: [{ text: msgAtivado }], sender: 'assistente', time: horaMensagem });
        salvarHistoricoEmDisco();
        updateClients();
        return;
    }

    if (statusConversasFinalizadas[sender]) {
        return;
    }

    const termosHumano = ['humano', 'atendente', 'pessoa', 'falar com alguém', 'alguém real', 'suporte humano', 'gerente'];
    const termosFechamento = [
        'quero contratar', 'vamos fechar', 'fechado', 'quero comprar',
        'finalizar compra', 'finalizar a compra', 'quero avançar', 'quero avancar',
        'quero assinar', 'assinar o plano', 'fechar o plano', 'fechar contrato'
    ];

    const querHumano = termosHumano.some(termo => cleanText.includes(termo));
    const querFecharCompra = termosFechamento.some(termo => cleanText.includes(termo));

    async function notificarResponsavelTransbordo(motivoTexto, resumoExtra = '') {
        const numeroDestino = '556299615120';
        if (senderNumber === numeroDestino || ehNumeroDono(senderNumber) || ehNumeroDono(sender)) return;

        const jidDestino = `${numeroDestino}@s.whatsapp.net`;
        const ultimasMensagens = (historicosConversas[sender] || [])
            .slice(-8)
            .map(m => {
                const autor = m.sender === 'assistente' ? 'Digitavia' : 'Cliente';
                const texto = m.parts?.[0]?.text || m.text || '';
                return `${autor}: ${texto}`;
            })
            .join('\n');

        const mensagemAlerta = resumoExtra
            ? `🔔 *NOVO ATENDIMENTO AGUARDANDO HUMANO*\n📱 *Contato:* ${nomeContatoPerfil ? `${nomeContatoPerfil} (${senderNumber})` : senderNumber}\n📌 *Motivo:* ${motivoTexto}\n\n${resumoExtra}`
            : [
                '🔔 *NOVO ATENDIMENTO AGUARDANDO HUMANO*',
                `📱 *Contato/Cliente:* ${nomeContatoPerfil ? `${nomeContatoPerfil} (${senderNumber})` : senderNumber}`,
                `📌 *Motivo:* ${motivoTexto}`,
                `\n💬 *Últimas mensagens:*\n${ultimasMensagens}`
            ].join('\n');

        try {
            await sock.sendMessage(jidDestino, { text: mensagemAlerta });
            statusAguardandoHumano[jidDestino] = false;
            limparAguardandoDoDono();
        } catch (err) {
            console.error('❌ Erro ao enviar notificação para 556299615120:', err);
        }
    }

    if (querHumano && !isOwner && !ehNumeroDono(sender) && !statusAguardandoHumano[sender]) {
        statusAguardandoHumano[sender] = true;
        statusUsuarios[sender] = false;

        const comandoAtivacaoExibido = botConfig.comandoLigar || 'digitavia on';
        const msgEspera = `Entendido! Estou transferindo seu atendimento para a nossa equipe e o chat foi pausado. Caso queira reativar o chat novamente a qualquer momento, basta enviar o comando: *${comandoAtivacaoExibido}*.`;

        await sock.sendMessage(sender, { text: msgEspera });
        historicosConversas[sender].push({ role: 'model', parts: [{ text: msgEspera }], sender: 'assistente', time: horaMensagem });
        salvarHistoricoEmDisco();
        await notificarResponsavelTransbordo('Cliente solicitou atendimento humano');
        updateClients();
        return;
    }

    const termosFim = ['tchau', 'obrigado', 'obrigada', 'valeu', 'ok, obrigado', 'entendi, obrigado', 'até mais', 't+'];
    const encerrouConversa = termosFim.some(termo => cleanText === termo.toLowerCase() || cleanText.includes('muito obrigado'));

    if (encerrouConversa) {
        statusConversasFinalizadas[sender] = true;
        statusUsuarios[sender] = false;

        if (!contatosBloqueados.includes(senderNumber) && !donosFixos.includes(senderNumber) && senderNumber !== donoConectado) {
            contatosBloqueados.push(senderNumber);
            salvarBloqueados(contatosBloqueados);
        }

        const comandoAtivacaoExibido = botConfig.comandoLigar || 'digitavia on';
        const msgFim = `Foi um prazer ajudar! Esta conversa foi finalizada e o chat foi pausado. Caso precise de mais algo no futuro e queira reativar o atendimento, basta enviar o comando: *${comandoAtivacaoExibido}*. Tenha um ótimo dia!`;

        await sock.sendMessage(sender, { text: msgFim });
        historicosConversas[sender].push({ role: 'model', parts: [{ text: msgFim }], sender: 'assistente', time: horaMensagem });
        salvarHistoricoEmDisco();
        updateClients();
        return;
    }

    const cmdDesligarInd = `${String(botConfig.nomeAgente || 'digitavia').toLowerCase()}-off`;

    if (cleanText === cmdDesligarInd || cleanText === 'digitavia-off' || cleanText === 'digitavia off') {
        statusUsuarios[sender] = false;
        await sock.sendMessage(sender, { text: `😴 ${botConfig.nomeAgente} foi desativado para esta conversa.` });
        updateClients();
        return;
    }

    if (statusUsuarios[sender] === undefined) statusUsuarios[sender] = true;
    if (!isBotActiveGlobal || !statusUsuarios[sender]) return;

    try {
        const userPartContent = [];
        if (fileBuffer) {
            userPartContent.push({
                inlineData: {
                    data: fileBuffer.toString('base64'),
                    mimeType
                }
            });
        }
        if (messageText) {
            userPartContent.push({ text: messageText });
        }

        const mensagemAtualPayload = {
            role: 'user',
            parts: userPartContent
        };

        const historicoParaEnvio = [...(historicosConversas[sender] || [])];
        if (historicoParaEnvio.length > 0 && historicoParaEnvio[historicoParaEnvio.length - 1].role === 'user') {
            historicoParaEnvio.pop();
        }
        historicoParaEnvio.push(mensagemAtualPayload);

        const { dataFormatada, horaFormatada } = obterDataHoraAtual();
        const saudacaoAtual = obterSaudacao();

        const instrucaoDinamica = `[Contexto de Tempo Real - Goiânia/BR]: Hoje é ${dataFormatada}, e agora são exatamente ${horaFormatada}.
            [Nome do Contato no WhatsApp]: ${nomeContatoPerfil || 'Desconhecido (pergunte educadamente se necessário)'}
            ${botConfig.systemInstruction}
            Importante: Inicie obrigatoriamente a primeira interação cumprimentando o contato com "${saudacaoAtual}" (e utilize o nome do contato se ele estiver disponível acima).
            Se o cliente (por texto ou áudio) pedir para falar com humano, atendente, pessoa ou equipe, responda normalmente e inclua ao final da sua resposta a tag exata: [TRANSFERIR_HUMANO]`;

        const response = await gerarConteudoComRotacao({
            model: MODELO_IA,
            contents: historicoParaEnvio,
            config: { systemInstruction: instrucaoDinamica }
        });

        const replyText = response.text || '';
        const pediuHumanoPelaIA = replyText.includes('[TRANSFERIR_HUMANO]');
        const respostaLimpa = replyText.replace(/\[TRANSFERIR_HUMANO\]/g, '').trim() || 'Desculpe, não consegui processar a mídia ou gerar uma resposta.';
        const horaResposta = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

        historicosConversas[sender].push({ role: 'model', parts: [{ text: respostaLimpa }], sender: 'assistente', time: horaResposta });
        salvarHistoricoEmDisco();
        await sock.sendMessage(sender, { text: respostaLimpa });

        if ((pediuHumanoPelaIA || querFecharCompra) && !isOwner && !ehNumeroDono(sender) && !statusAguardandoHumano[sender]) {
            statusAguardandoHumano[sender] = true;
            statusUsuarios[sender] = false;

            let resumoLead = '';
            try {
                const promptResumo = `Com base nesta conversa, gere um resumo objetivo no formato:
                    NOVO LEAD - DIGITAVIA
                    Nome:
                    Negocio:
                    Vertical:
                    Numeros de WhatsApp:
                    Volume:
                    Recebe audio/foto?:
                    Dor principal:
                    Plano de interesse:
                    Resumo da conversa:

                    Conversa:
                    ${historicoParaEnvio.map(m => `${m.role === 'user' ? 'Cliente' : 'Digitavia'}: ${m.parts?.map(p => p.text || '[mídia]').join(' ')}`).join('\n')}`;

                const respResumo = await gerarConteudoComRotacao({
                    model: MODELO_IA,
                    contents: [{ role: 'user', parts: [{ text: promptResumo }] }]
                });
                resumoLead = respResumo.text?.trim() || '';
            } catch (e) {
                console.warn('⚠️ Não foi possível gerar resumo via IA, enviando log básico:', e.message);
            }

            const motivoAlerta = pediuHumanoPelaIA
                ? 'Cliente solicitou atendimento humano'
                : 'Cliente finalizou / demonstrou interesse em fechar a contratação';

            await notificarResponsavelTransbordo(motivoAlerta, resumoLead);
        }

        updateClients();
    } catch (error) {
        console.error('❌ Erro crítico: Todas as chaves da API falharam ou ocorreu um erro no Gemini:', error);
        await sock.sendMessage(sender, { text: 'Recebi sua mensagem! Logo alguém da nossa equipe vai te responder por aqui. 🙏' });
    }
}

// =========================================================
// 🔒 PROTEÇÃO DO SOCKET.IO POR SESSÃO AUTENTICADA
// =========================================================
io.use((socket, next) => {
    const cookies = parseCookies({ headers: { cookie: socket.handshake.headers.cookie || '' } });
    const senhaCookie = cookies[NOME_COOKIE_SESSAO];
    if (senhaCookie && senhaCookie === obterSenhaAtual()) {
        return next();
    }
    return next(new Error('UNAUTHORIZED'));
});

io.on('connection', (socket) => {
    updateClients();

    socket.on('limpar_aguardando', (jid) => {
        if (ehNumeroDono(jid)) return;
        limparEstadoAguardandoJid(jid);
        updateClients();
    });

    socket.on('atendido_e_bloquear', (payload) => {
        const jid = typeof payload === 'string' ? payload : payload?.jid;
        const numeroExtra = typeof payload === 'object' ? payload?.numero : '';
        const numeroLimpo = formatarNumero(numeroExtra || String(jid || '').split('@')[0].split(':')[0]);

        if (ehNumeroDono(numeroLimpo) || ehNumeroDono(jid)) {
            return;
        }

        if (jid) {
            const alvoNorm = normalizarJidChave(jid);
            Object.keys(statusAguardandoHumano).forEach((chave) => {
                const chaveNorm = normalizarJidChave(chave);
                const numChave = formatarNumero(String(chave || '').split('@')[0].split(':')[0]);
                if (chave === jid || chaveNorm === alvoNorm || (numeroLimpo && numChave === numeroLimpo)) {
                    statusAguardandoHumano[chave] = false;
                    statusConversasFinalizadas[chave] = true;
                    statusUsuarios[chave] = false;
                }
            });
            statusAguardandoHumano[jid] = false;
            statusConversasFinalizadas[jid] = true;
            statusUsuarios[jid] = false;
        }

        if (numeroLimpo && !contatosBloqueados.includes(numeroLimpo)) {
            contatosBloqueados.push(numeroLimpo);
            salvarBloqueados(contatosBloqueados);
        }

        limparAguardandoDoDono();
        updateClients();
    });

    socket.on('toggle_global_bot', (status) => {
        isBotActiveGlobal = Boolean(status);
        updateClients();
    });

    socket.on('toggle_user_bot', ({ sender, status }) => {
        if (!sender || ehNumeroDono(sender)) return;
        statusUsuarios[sender] = Boolean(status);
        if (status) {
            statusConversasFinalizadas[sender] = false;
            statusAguardandoHumano[sender] = false;
        }
        updateClients();
    });

    socket.on('finalizar_conversa', (jid) => {
        if (!jid || ehNumeroDono(jid)) return;
        statusConversasFinalizadas[jid] = true;
        statusAguardandoHumano[jid] = false;
        updateClients();
    });

    socket.on('reativar_conversa', (jid) => {
        if (!jid || ehNumeroDono(jid)) return;
        statusConversasFinalizadas[jid] = false;
        statusAguardandoHumano[jid] = false;
        statusUsuarios[jid] = true;
        updateClients();
    });

    socket.on('add_blocked_user', (numeroRaw) => {
        const numLimpo = formatarNumero(numeroRaw);

        if (numLimpo === donoConectado || donosFixos.includes(numLimpo)) {
            console.log(`⚠️ Tentativa bloqueada: Tentativa de bloquear o número do dono (${numLimpo}) via painel web.`);
            return;
        }

        if (numLimpo && !contatosBloqueados.includes(numLimpo)) {
            contatosBloqueados.push(numLimpo);
            salvarBloqueados(contatosBloqueados);
            updateClients();
        }
    });

    socket.on('remove_blocked_user', (numLimpo) => {
        const alvo = formatarNumero(numLimpo);
        contatosBloqueados = contatosBloqueados.filter(n => n !== alvo && n !== numLimpo);
        salvarBloqueados(contatosBloqueados);
        updateClients();
    });

    socket.on('clear_memory', () => {
        Object.keys(historicosConversas).forEach(key => delete historicosConversas[key]);
        Object.keys(statusAguardandoHumano).forEach(key => delete statusAguardandoHumano[key]);
        Object.keys(statusConversasFinalizadas).forEach(key => delete statusConversasFinalizadas[key]);
        if (fs.existsSync(ARQUIVO_HISTORICO)) fs.unlinkSync(ARQUIVO_HISTORICO);
        updateClients();
    });

    socket.on('save_agent_config', (novosDados = {}) => {
        const senhaAnterior = obterSenhaAtual();
        if (novosDados.nomeAgente) botConfig.nomeAgente = String(novosDados.nomeAgente).trim();
        if (novosDados.systemInstruction) botConfig.systemInstruction = String(novosDados.systemInstruction).trim();
        if (novosDados.comandoLigar) botConfig.comandoLigar = String(novosDados.comandoLigar).trim();
        if (novosDados.comandoDesligar) botConfig.comandoDesligar = String(novosDados.comandoDesligar).trim();
        if (novosDados.comandoBloquear) botConfig.comandoBloquear = String(novosDados.comandoBloquear).trim();
        if (novosDados.comandoDesbloquear) botConfig.comandoDesbloquear = String(novosDados.comandoDesbloquear).trim();
        if (novosDados.comandoVerBloqueados) botConfig.comandoVerBloqueados = String(novosDados.comandoVerBloqueados).trim();
        if (novosDados.msgVerBloqueados) botConfig.msgVerBloqueados = String(novosDados.msgVerBloqueados).trim();
        if (novosDados.apiKey && String(novosDados.apiKey).trim() !== '') {
            const keyLimpa = String(novosDados.apiKey).trim();
            botConfig.apiKey = keyLimpa;
            if (!Array.isArray(botConfig.apiKeys)) botConfig.apiKeys = [];
            if (!botConfig.apiKeys.includes(keyLimpa)) {
                botConfig.apiKeys.unshift(keyLimpa);
            }
        }
        if (novosDados.apiKeys && Array.isArray(novosDados.apiKeys)) {
            botConfig.apiKeys = novosDados.apiKeys.map(k => String(k).trim()).filter(Boolean);
        }
        if (novosDados.senhaPainel && String(novosDados.senhaPainel).trim() !== '') {
            botConfig.senhaPainel = String(novosDados.senhaPainel).trim();
        }

        const senhaAlterada = obterSenhaAtual() !== senhaAnterior;
        salvarConfig(botConfig);
        updateClients();
        socket.emit('config_saved_success', {
            message: senhaAlterada
                ? 'Configurações e nova senha salvas com sucesso!'
                : 'Configurações do Agente salvas com sucesso!',
            senhaAlterada
        });
    });
});

server.listen(PORT, () => {
    console.log(`🌐 Painel Web rodando em: http://localhost:${PORT}`);
    carregarHistoricoEmDisco();
    connectToWhatsApp();

    const url = `http://localhost:${PORT}`;
    const startCommand = process.platform === 'win32'
        ? `start ${url}`
        : process.platform === 'darwin'
            ? `open ${url}`
            : `xdg-open ${url}`;
    exec(startCommand);
});
