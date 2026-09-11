/* ===========================================================
   Nexus — front-end (app.js)
   Conecta ao servidor por WebSocket (Socket.IO) e faz a
   navegação entre servidores, canais e mensagens em tempo real.
   =========================================================== */

const app = document.getElementById("app");
const EU = { id: parseInt(app.dataset.uid), nome: app.dataset.unome };

let socket = null;
let servidorAtual = null;
let canalAtual = null;
let ultimoAutor = null;
let timerDigitando = null;
let respondendoA = null;   // {id, autor, conteudo} quando respondendo
const EMOJIS_RAPIDOS = ["👍", "❤️", "😂", "🔥", "🎉", "😮"];

/* ---------------- utilidades ---------------- */
function corDe(str) {
  // cor derivada do nome (estável) para avatares
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  const paleta = ["#a855f7", "#f0663f", "#5b8def", "#c084fc", "#f4b740", "#4ade80", "#fb7185"];
  return paleta[Math.abs(h) % paleta.length];
}
function iniciais(nome) { return (nome || "?").trim()[0].toUpperCase(); }
function horaBonita(iso) {
  const d = new Date(iso.replace(" ", "T"));
  if (isNaN(d)) return "";
  const hoje = new Date();
  const mesmaData = d.toDateString() === hoje.toDateString();
  const hm = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return mesmaData ? `hoje às ${hm}` : d.toLocaleDateString("pt-BR") + " " + hm;
}
function escapar(t) {
  const d = document.createElement("div");
  d.textContent = t;
  return d.innerHTML;
}
async function jget(url) { const r = await fetch(url); return r.json(); }
async function jpost(url, corpo) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo || {}) });
  return { ok: r.ok, dados: await r.json() };
}

/* ---------------- alternar tela inicial (amigos) x chat ---------------- */
function mostrarTelaAmigos() {
  document.getElementById("telaAmigos").hidden = false;
  document.getElementById("chatCabecalho").hidden = true;
  document.getElementById("mensagens").hidden = true;
  document.getElementById("formEnvio").hidden = true;
  document.getElementById("colMembros").hidden = true;
  document.getElementById("servidorNome").textContent = "Início";
  document.getElementById("btnConvite").hidden = true;
  document.getElementById("canaisLista").innerHTML =
    '<div class="vazio-canais">Você ainda não abriu um servidor. Crie um no botão + à esquerda.</div>';
  document.querySelectorAll(".srv-btn").forEach((x) => x.classList.remove("ativo"));
  document.querySelector('.srv-btn.inicio').classList.add("ativo");
  if (canalAtual && socket) { socket.emit("sair_canal", { canal_id: canalAtual }); canalAtual = null; }
}
function mostrarChat() {
  document.getElementById("telaAmigos").hidden = true;
  document.getElementById("chatCabecalho").hidden = false;
  document.getElementById("mensagens").hidden = false;
  document.getElementById("formEnvio").hidden = false;
}

/* ---------------- WebSocket ---------------- */
function conectarSocket() {
  socket = io();
  socket.on("nova_mensagem", (m) => {
    if (m.canal_id === canalAtual) adicionarMensagem(m);
    // toca som só quando é de outra pessoa (não nas suas próprias)
    if (m.autor_id !== EU.id) tocarNotificacao();
  });
  socket.on("mensagem_editada", (d) => {
    if (d.canal_id !== canalAtual) return;
    const el = document.querySelector(`.msg[data-id="${d.id}"] .msg-texto`);
    if (el) { el.innerHTML = escapar(d.conteudo) + ' <span class="editada">(editada)</span>'; }
  });
  socket.on("mensagem_apagada", (d) => {
    if (d.canal_id !== canalAtual) return;
    const el = document.querySelector(`.msg[data-id="${d.id}"]`);
    if (el) el.remove();
  });
  socket.on("reacao_atualizada", (d) => {
    if (d.canal_id !== canalAtual) return;
    atualizarReacaoUI(d);
  });
  socket.on("usuario_digitando", (d) => {
    if (d.canal_id !== canalAtual) return;
    const aviso = document.getElementById("digitandoAviso");
    aviso.textContent = `${d.nome} está digitando...`;
    clearTimeout(timerDigitando);
    timerDigitando = setTimeout(() => (aviso.textContent = ""), 2500);
  });
}

/* ---------------- servidores ---------------- */
async function carregarServidores() {
  const servidores = await jget("/api/servidores");
  const lista = document.getElementById("srvLista");
  lista.innerHTML = "";
  servidores.forEach((s) => {
    const b = document.createElement("button");
    b.className = "srv-btn";
    b.dataset.servidor = s.id;
    b.title = s.nome;
    b.innerHTML = `<span class="srv-icone-letra">${iniciais(s.nome)}</span>`;
    b.style.setProperty("--cor", corDe(s.nome));
    b.addEventListener("click", () => abrirServidor(s.id, b));
    lista.appendChild(b);
  });
}

async function abrirServidor(sid, botao) {
  document.querySelectorAll(".srv-btn").forEach((x) => x.classList.remove("ativo"));
  if (botao) botao.classList.add("ativo");

  const s = await jget(`/api/servidores/${sid}`);
  if (s.erro) { alert(s.erro); return; }
  servidorAtual = s;

  document.getElementById("servidorNome").textContent = s.nome;
  const btnConvite = document.getElementById("btnConvite");
  btnConvite.hidden = false;
  btnConvite.onclick = () => mostrarConvite(s.convite);

  // monta canais por categoria
  const cont = document.getElementById("canaisLista");
  cont.innerHTML = "";
  const podeCriar = (s.dono_id === EU.id); // simplificado: dono cria canais
  s.categorias.forEach((cat) => {
    const tit = document.createElement("div");
    tit.className = "categoria-titulo";
    tit.innerHTML = `<span>${escapar(cat.nome)}</span>` +
      (podeCriar ? `<button class="categoria-add" title="Novo canal">+</button>` : "");
    if (podeCriar) tit.querySelector(".categoria-add").onclick = () => criarCanal(sid, cat.id);
    cont.appendChild(tit);
    cat.canais.forEach((c) => cont.appendChild(itemCanal(c)));
  });
  s.sem_categoria.forEach((c) => cont.appendChild(itemCanal(c)));

  // membros
  const colM = document.getElementById("colMembros");
  colM.hidden = false;
  const ml = document.getElementById("membrosLista");
  ml.innerHTML = "";
  s.membros.forEach((m) => {
    const el = document.createElement("div");
    el.className = "membro-item";
    const cor = m.cor && m.cor !== "#a855f7" ? m.cor : corDe(m.nome);
    const papel = m.papel === "dono" ? '<span class="membro-papel papel-dono">dono</span>'
      : m.papel === "admin" ? '<span class="membro-papel papel-admin">admin</span>' : "";
    el.innerHTML = `<span class="membro-avatar" style="background:${cor}">${iniciais(m.nome)}</span>
                    <span class="membro-nome">${escapar(m.nome)}</span>${papel}`;
    ml.appendChild(el);
  });

  // abre o primeiro canal automaticamente
  const primeiro = cont.querySelector(".canal-item");
  if (primeiro) primeiro.click();
}

function itemCanal(c) {
  const el = document.createElement("div");
  el.className = "canal-item";
  el.dataset.canal = c.id;
  el.innerHTML = `<span class="hash">#</span> ${escapar(c.nome)}`;
  el.addEventListener("click", () => abrirCanal(c, el));
  return el;
}

/* ---------------- canais e mensagens ---------------- */
async function abrirCanal(canal, el) {
  // sai do canal anterior (socket)
  if (canalAtual && socket) socket.emit("sair_canal", { canal_id: canalAtual });

  document.querySelectorAll(".canal-item").forEach((x) => x.classList.remove("ativo"));
  if (el) el.classList.add("ativo");
  canalAtual = canal.id;
  ultimoAutor = null;
  mostrarChat();

  document.getElementById("canalNome").textContent = canal.nome;
  document.getElementById("canalDescricao").textContent = canal.descricao || "";
  document.getElementById("formEnvio").hidden = false;

  socket.emit("entrar_canal", { canal_id: canal.id });

  const msgs = await jget(`/api/canais/${canal.id}/mensagens`);
  const cont = document.getElementById("mensagens");
  cont.innerHTML = "";
  if (!msgs.length) {
    cont.innerHTML = `<div class="boas-vindas"><div class="bv-icone"><img class="av-logo" src="/static/img/logo.png" alt=""></div>
      <h2>#${escapar(canal.nome)}</h2><p>Este é o começo do canal. Mande a primeira mensagem.</p></div>`;
  } else {
    msgs.forEach((m) => adicionarMensagem(m));
  }
  document.getElementById("entradaMsg").focus();
}

function adicionarMensagem(m) {
  const cont = document.getElementById("mensagens");
  const bv = cont.querySelector(".boas-vindas");
  if (bv) bv.remove();

  const agrupada = (ultimoAutor === m.autor_id) && !m.responde_a;
  const cor = m.cor && m.cor !== "#a855f7" ? m.cor : corDe(m.autor);
  const souAutor = (m.autor_id === EU.id);
  const el = document.createElement("div");
  el.className = "msg" + (agrupada ? " agrupada" : "");
  el.dataset.id = m.id;
  el.dataset.autorId = m.autor_id;

  const citacao = m.resposta ? `
    <div class="msg-citacao">
      <span class="cit-autor">${escapar(m.resposta.autor)}</span>
      <span class="cit-texto">${escapar(m.resposta.conteudo).slice(0, 120)}</span>
    </div>` : "";

  const marcaEditada = m.editada ? ' <span class="editada">(editada)</span>' : "";

  el.innerHTML = `
    <div class="msg-avatar" style="background:${cor}">${iniciais(m.autor)}</div>
    <div class="msg-corpo">
      ${citacao}
      <div class="msg-cabecalho">
        <span class="msg-autor" style="color:${cor}">${escapar(m.autor)}</span>
        <span class="msg-hora">${horaBonita(m.criado_em)}</span>
      </div>
      <div class="msg-texto">${escapar(m.conteudo)}${marcaEditada}</div>
      <div class="msg-reacoes"></div>
    </div>
    <div class="msg-acoes">
      <button class="acao-msg" data-a="reagir" title="Reagir">☺</button>
      <button class="acao-msg" data-a="responder" title="Responder">↰</button>
      ${souAutor ? '<button class="acao-msg" data-a="editar" title="Editar">✎</button>' : ""}
      ${souAutor ? '<button class="acao-msg" data-a="apagar" title="Apagar">🗑</button>' : ""}
    </div>`;

  // ações
  el.querySelector('[data-a="reagir"]').onclick = (e) => abrirSeletorEmoji(e, m.id);
  el.querySelector('[data-a="responder"]').onclick = () => iniciarResposta(m);
  if (souAutor) {
    el.querySelector('[data-a="editar"]').onclick = () => iniciarEdicao(el, m);
    el.querySelector('[data-a="apagar"]').onclick = () => {
      if (confirm("Apagar esta mensagem?")) socket.emit("apagar_mensagem", { id: m.id });
    };
  }

  cont.appendChild(el);
  // renderiza reações existentes
  (m.reacoes || []).forEach((r) => desenharReacao(m.id, r.emoji, r.total, r.eu));
  cont.scrollTop = cont.scrollHeight;
  ultimoAutor = m.responde_a ? null : m.autor_id;
}

/* ---- resposta ---- */
function iniciarResposta(m) {
  respondendoA = { id: m.id, autor: m.autor };
  const barra = document.getElementById("barraResposta");
  barra.hidden = false;
  barra.querySelector(".resp-texto").textContent = `Respondendo a ${m.autor}`;
  document.getElementById("entradaMsg").focus();
}
function cancelarResposta() {
  respondendoA = null;
  document.getElementById("barraResposta").hidden = true;
}

/* ---- edição inline ---- */
function iniciarEdicao(el, m) {
  const corpoTexto = el.querySelector(".msg-texto");
  const original = m.conteudo;
  corpoTexto.innerHTML = `
    <input class="editar-input" value="${original.replace(/"/g, "&quot;")}">
    <div class="editar-dica">Enter para salvar · Esc para cancelar</div>`;
  const inp = corpoTexto.querySelector(".editar-input");
  inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const novo = inp.value.trim();
      if (novo && novo !== original) socket.emit("editar_mensagem", { id: m.id, conteudo: novo });
      else corpoTexto.innerHTML = escapar(original) + (m.editada ? ' <span class="editada">(editada)</span>' : "");
    } else if (e.key === "Escape") {
      corpoTexto.innerHTML = escapar(original) + (m.editada ? ' <span class="editada">(editada)</span>' : "");
    }
  });
}

/* ---- reações ---- */
function abrirSeletorEmoji(ev, mid) {
  fecharSeletorEmoji();
  const menu = document.createElement("div");
  menu.className = "emoji-menu";
  menu.id = "emojiMenu";
  EMOJIS_RAPIDOS.forEach((e) => {
    const b = document.createElement("button");
    b.textContent = e;
    b.onclick = () => { socket.emit("alternar_reacao", { id: mid, emoji: e }); fecharSeletorEmoji(); };
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  const r = ev.target.getBoundingClientRect();
  menu.style.top = (r.top - 46) + "px";
  menu.style.left = Math.min(r.left, window.innerWidth - 220) + "px";
  setTimeout(() => document.addEventListener("click", fecharSeletorEmoji, { once: true }), 0);
}
function fecharSeletorEmoji() {
  const m = document.getElementById("emojiMenu");
  if (m) m.remove();
}
function desenharReacao(mid, emoji, total, eu) {
  const cont = document.querySelector(`.msg[data-id="${mid}"] .msg-reacoes`);
  if (!cont) return;
  let chip = cont.querySelector(`.reacao[data-emoji="${emoji}"]`);
  if (total <= 0) { if (chip) chip.remove(); return; }
  if (!chip) {
    chip = document.createElement("button");
    chip.className = "reacao";
    chip.dataset.emoji = emoji;
    chip.onclick = () => socket.emit("alternar_reacao", { id: mid, emoji });
    cont.appendChild(chip);
  }
  chip.classList.toggle("eu", !!eu);
  chip.innerHTML = `<span>${emoji}</span> <span class="reacao-num">${total}</span>`;
}
function atualizarReacaoUI(d) {
  const souEu = (d.por_usuario === EU.id);
  const chip = document.querySelector(`.msg[data-id="${d.id}"] .reacao[data-emoji="${d.emoji}"]`);
  const euAtual = chip ? chip.classList.contains("eu") : false;
  // "eu" só muda se fui eu que reagi; senão preserva
  const eu = souEu ? d.adicionou : euAtual;
  desenharReacao(d.id, d.emoji, d.total, eu);
}

/* ---------------- envio ---------------- */
document.getElementById("formEnvio").addEventListener("submit", (e) => {
  e.preventDefault();
  const inp = document.getElementById("entradaMsg");
  const txt = inp.value.trim();
  if (!txt || !canalAtual) return;
  socket.emit("enviar_mensagem", {
    canal_id: canalAtual, conteudo: txt,
    responde_a: respondendoA ? respondendoA.id : null,
  });
  inp.value = "";
  cancelarResposta();
});
document.getElementById("entradaMsg").addEventListener("input", () => {
  if (canalAtual && socket) socket.emit("digitando", { canal_id: canalAtual });
});
document.getElementById("respCancelar").addEventListener("click", cancelarResposta);
document.getElementById("entradaMsg").addEventListener("keydown", (e) => {
  if (e.key === "Escape") cancelarResposta();
});

/* ---------------- criar/entrar servidor ---------------- */
const modalFundo = document.getElementById("modalFundo");
const modal = document.getElementById("modal");
function fecharModal() { modalFundo.hidden = true; modal.innerHTML = ""; }
modalFundo.addEventListener("click", (e) => { if (e.target === modalFundo) fecharModal(); });

document.getElementById("btnNovoServidor").addEventListener("click", () => abrirModalNovoServidor());

const MOLDES_UI = [
  { id: "jogos",   emoji: "🎮", nome: "Jogos" },
  { id: "amigos",  emoji: "💜", nome: "Amigos" },
  { id: "estudos", emoji: "📚", nome: "Grupo de estudos" },
  { id: "escolar", emoji: "🏫", nome: "Clube escolar" },
];

function abrirModalNovoServidor() {
  modalFundo.hidden = false;
  modal.innerHTML = `
    <div class="modal-topo">
      <div>
        <h2>Criar seu servidor</h2>
        <p class="m-sub">Seu servidor é onde você e seus amigos se reúnem. Crie o seu e comece a interagir.</p>
      </div>
      <button class="modal-fechar" id="mFechar" aria-label="Fechar">&times;</button>
    </div>
    <div class="moldes-lista">
      <button class="molde-btn destaque" data-molde="padrao">
        <span class="molde-emoji">✳️</span> Criar o meu
        <span class="molde-seta">&rsaquo;</span>
      </button>
      <div class="molde-sec">Começar de um molde</div>
      ${MOLDES_UI.map(m => `
        <button class="molde-btn" data-molde="${m.id}">
          <span class="molde-emoji">${m.emoji}</span> ${m.nome}
          <span class="molde-seta">&rsaquo;</span>
        </button>`).join("")}
    </div>
    <div class="modal-rodape-conv">
      <p>Já tem um convite?</p>
      <button class="btn-sec" id="mEntrarConvite" style="width:100%">Entrar em um servidor</button>
    </div>`;

  document.getElementById("mFechar").onclick = fecharModal;
  document.getElementById("mEntrarConvite").onclick = abrirModalConvite;
  modal.querySelectorAll(".molde-btn").forEach((b) => {
    b.onclick = () => etapaNomearServidor(b.dataset.molde);
  });
}

function etapaNomearServidor(molde) {
  const rotulo = { jogos: "Jogos", amigos: "Amigos", estudos: "Grupo de estudos",
                   escolar: "Clube escolar", padrao: "Meu servidor" }[molde] || "Meu servidor";
  modal.innerHTML = `
    <div class="modal-topo">
      <div><h2>Personalize seu servidor</h2>
        <p class="m-sub">Dê um nome. Você pode mudar depois.</p></div>
      <button class="modal-fechar" id="mFechar" aria-label="Fechar">&times;</button>
    </div>
    <label>Nome do servidor
      <input id="nomeSrv" maxlength="40" placeholder="Ex: ${rotulo} da galera" value="">
    </label>
    <div class="modal-acoes">
      <button class="btn-sec" id="mVoltar">Voltar</button>
      <button class="btn-pri" id="mCriar">Criar servidor</button>
    </div>`;
  document.getElementById("mFechar").onclick = fecharModal;
  document.getElementById("mVoltar").onclick = abrirModalNovoServidor;
  const inp = document.getElementById("nomeSrv");
  inp.focus();
  document.getElementById("mCriar").onclick = async () => {
    const nome = inp.value.trim() || inp.placeholder.replace("Ex: ", "");
    const { ok, dados } = await jpost("/api/servidores", { nome, molde });
    if (ok) {
      fecharModal();
      await carregarServidores();
      const btn = document.querySelector(`.srv-btn[data-servidor="${dados.id}"]`);
      abrirServidor(dados.id, btn);
    } else alert(dados.erro || "Erro ao criar.");
  };
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("mCriar").click(); });
}

function abrirModalConvite() {
  modalFundo.hidden = false;
  modal.innerHTML = `
    <div class="modal-topo">
      <div><h2>Entrar em um servidor</h2>
        <p class="m-sub">Digite o código do convite que te enviaram.</p></div>
      <button class="modal-fechar" id="mFechar" aria-label="Fechar">&times;</button>
    </div>
    <label>Código do convite
      <input id="codConvite" maxlength="12" placeholder="ex: k4p2mx9a">
    </label>
    <div class="modal-acoes">
      <button class="btn-sec" id="mVoltar">Voltar</button>
      <button class="btn-pri" id="mEntrar">Entrar</button>
    </div>`;
  document.getElementById("mFechar").onclick = fecharModal;
  document.getElementById("mVoltar").onclick = abrirModalNovoServidor;
  const inp = document.getElementById("codConvite");
  inp.focus();
  document.getElementById("mEntrar").onclick = async () => {
    const convite = inp.value.trim();
    if (!convite) return;
    const { ok, dados } = await jpost("/api/servidores/entrar", { convite });
    if (ok) {
      fecharModal();
      await carregarServidores();
      const btn = document.querySelector(`.srv-btn[data-servidor="${dados.id}"]`);
      abrirServidor(dados.id, btn);
    } else alert(dados.erro || "Convite inválido.");
  };
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("mEntrar").click(); });
}

async function criarCanal(sid, categoriaId) {
  const nome = prompt("Nome do novo canal:");
  if (!nome || !nome.trim()) return;
  const { ok, dados } = await jpost(`/api/servidores/${sid}/canais`, { nome: nome.trim(), categoria_id: categoriaId });
  if (ok) abrirServidor(sid, document.querySelector(`.srv-btn[data-servidor="${sid}"]`));
  else alert(dados.erro || "Erro ao criar canal.");
}

function mostrarConvite(codigo) {
  modalFundo.hidden = false;
  modal.innerHTML = `
    <h2>Convite do servidor</h2>
    <p class="m-sub">Compartilhe este código. Quem tiver ele pode entrar pelo botão + &rarr; "Entrar com convite".</p>
    <div class="convite-codigo">${escapar(codigo)}</div>
    <div class="modal-acoes">
      <button class="btn-sec" id="copiar">Copiar</button>
      <button class="btn-pri" id="fechar">Pronto</button>
    </div>`;
  document.getElementById("fechar").onclick = fecharModal;
  document.getElementById("copiar").onclick = () => {
    navigator.clipboard.writeText(codigo).then(() => {
      document.getElementById("copiar").textContent = "Copiado!";
    }).catch(() => {});
  };
}

/* ---------------- som de notificação ---------------- */
let somLigado = true;
try { somLigado = localStorage.getItem("nexus_som") !== "off"; } catch (e) {}

function tocarNotificacao() {
  if (!somLigado) return;
  const a = document.getElementById("somNotif");
  if (!a) return;
  try { a.currentTime = 0; a.play().catch(() => {}); } catch (e) {}
}

function atualizarBotaoSom() {
  const b = document.getElementById("btnSom");
  if (!b) return;
  b.textContent = somLigado ? "🔔" : "🔕";
  b.title = somLigado ? "Som ligado (clique para desligar)" : "Som desligado (clique para ligar)";
  b.classList.toggle("mudo", !somLigado);
}

document.getElementById("btnSom").addEventListener("click", () => {
  somLigado = !somLigado;
  try { localStorage.setItem("nexus_som", somLigado ? "on" : "off"); } catch (e) {}
  atualizarBotaoSom();
  if (somLigado) tocarNotificacao(); // toca uma prévia ao ligar
});
atualizarBotaoSom();

/* ---------------- início ---------------- */
document.querySelector(".srv-btn.inicio").addEventListener("click", mostrarTelaAmigos);
document.getElementById("btnCriarDaTela").addEventListener("click", () => abrirModalNovoServidor());

(async function iniciar() {
  conectarSocket();
  await carregarServidores();
  // sempre começa na tela inicial de Amigos (sem abrir servidor)
  mostrarTelaAmigos();
})();
