"""
app.py — Nexus (MVP de chat com comunidades, tempo real via WebSocket)

Stack: Flask + Flask-SocketIO. As mensagens são entregues instantaneamente
a quem está no mesmo canal (via "rooms" do Socket.IO).

Rotas HTTP:
  /                     redireciona para /app ou /entrar
  /entrar, /registrar   autenticação
  /sair                 logout
  /app                  a aplicação (interface principal)
  APIs JSON para servidores, canais, mensagens e convites

Eventos WebSocket:
  entrar_canal / sair_canal   controla em qual sala o cliente está
  enviar_mensagem             grava e retransmite a mensagem em tempo real
  digitando                   indicador "fulano está digitando"
"""

import os
import json
from functools import wraps
from flask import (
    Flask, render_template, request, jsonify, redirect, url_for, session
)
from werkzeug.security import check_password_hash, generate_password_hash
from flask_socketio import SocketIO, join_room, leave_room, emit

import database as db

app = Flask(__name__)
app.secret_key = os.environ.get("NEXUS_SECRET", "troque-esta-chave-em-producao")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# Presença: usuario_id -> quantidade de conexões abertas (abas/dispositivos)
_online = {}

# Chamadas ativas (voz/vídeo). Não fica salvo no banco — é só enquanto dura,
# igual à presença online. chamada_id -> dict com participantes, tipo, dono.
_chamadas = {}
CHAMADA_MAX_PARTICIPANTES = 10


def _chamada_info_publica(cid):
    c = _chamadas.get(cid)
    if not c:
        return None
    return {"id": cid, "tipo": c["tipo"], "participantes": list(c["participantes"])}


def _sair_de_todas_chamadas(uid):
    """Remove o usuário de qualquer chamada em que esteja (usado no disconnect)."""
    for cid in list(_chamadas.keys()):
        c = _chamadas.get(cid)
        if c and uid in c["participantes"]:
            c["participantes"].discard(uid)
            socketio.emit("chamada_participante_saiu", {"chamada_id": cid, "usuario_id": uid},
                          room=f"chamada_{cid}")
            if not c["participantes"]:
                del _chamadas[cid]


# ---------------- helpers ----------------

def logado():
    return "usuario" in session


def usuario_atual():
    return session.get("usuario")


def login_obrigatorio(f):
    @wraps(f)
    def wrapper(*a, **k):
        if not logado():
            return redirect(url_for("entrar"))
        return f(*a, **k)
    return wrapper


def api_login(f):
    @wraps(f)
    def wrapper(*a, **k):
        if not logado():
            return jsonify({"erro": "Não autenticado"}), 401
        return f(*a, **k)
    return wrapper


def eh_membro(conn, servidor_id, usuario_id):
    return conn.execute(
        "SELECT 1 FROM membros WHERE servidor_id=? AND usuario_id=?",
        (servidor_id, usuario_id),
    ).fetchone() is not None


def canal_do_usuario(conn, canal_id, usuario_id):
    """Retorna o canal se o usuário for membro do servidor dele e puder vê-lo; senão None."""
    row = conn.execute(
        """SELECT c.* FROM canais c
           JOIN membros m ON m.servidor_id = c.servidor_id
           WHERE c.id=? AND m.usuario_id=?""",
        (canal_id, usuario_id),
    ).fetchone()
    if row and not db.pode_ver_canal(conn, row, row["servidor_id"], usuario_id):
        return None
    return row


# ==================== AUTENTICAÇÃO ====================

@app.route("/")
def home():
    return redirect(url_for("app_principal") if logado() else url_for("entrar"))


@app.route("/entrar", methods=["GET", "POST"])
def entrar():
    if logado():
        return redirect(url_for("app_principal"))
    erro = None
    if request.method == "POST":
        u = request.form.get("usuario", "").strip().lower()
        s = request.form.get("senha", "")
        with db.get_connection() as conn:
            row = conn.execute("SELECT * FROM usuarios WHERE usuario=?", (u,)).fetchone()
        if row and check_password_hash(row["senha_hash"], s):
            session["usuario"] = {
                "id": row["id"], "usuario": row["usuario"],
                "nome": row["nome_exibicao"], "cor": row["cor"],
            }
            return redirect(url_for("app_principal"))
        erro = "Usuário ou senha incorretos."
    return render_template("entrar.html", erro=erro, modo="entrar")


@app.route("/registrar", methods=["GET", "POST"])
def registrar():
    if logado():
        return redirect(url_for("app_principal"))
    erro = None
    if request.method == "POST":
        u = request.form.get("usuario", "").strip().lower()
        nome = request.form.get("nome", "").strip() or u
        s = request.form.get("senha", "")
        if not u.isalnum() or len(u) < 3:
            erro = "O usuário deve ter ao menos 3 caracteres, só letras e números."
        elif len(s) < 6:
            erro = "A senha deve ter ao menos 6 caracteres."
        else:
            row = None
            with db.get_connection() as conn:
                if conn.execute("SELECT 1 FROM usuarios WHERE usuario=?", (u,)).fetchone():
                    erro = "Esse nome de usuário já existe."
                else:
                    conn.execute(
                        "INSERT INTO usuarios (usuario, nome_exibicao, senha_hash, criado_em) VALUES (?,?,?,?)",
                        (u, nome, generate_password_hash(s), db.agora()),
                    )
                    row = conn.execute("SELECT * FROM usuarios WHERE usuario=?", (u,)).fetchone()
            if row:
                session["usuario"] = {"id": row["id"], "usuario": row["usuario"],
                                      "nome": row["nome_exibicao"], "cor": row["cor"]}
                return redirect(url_for("app_principal"))
    return render_template("entrar.html", erro=erro, modo="registrar")


@app.route("/sair")
def sair():
    session.pop("usuario", None)
    return redirect(url_for("entrar"))


@app.route("/app")
@login_obrigatorio
def app_principal():
    return render_template("app.html", usuario=usuario_atual())


# ==================== API: SERVIDORES ====================

@app.route("/api/servidores")
@api_login
def api_servidores():
    uid = usuario_atual()["id"]
    with db.get_connection() as conn:
        linhas = conn.execute(
            """SELECT s.id, s.nome, s.convite, m.papel
               FROM servidores s JOIN membros m ON m.servidor_id = s.id
               WHERE m.usuario_id=? ORDER BY s.id""",
            (uid,),
        ).fetchall()
    return jsonify([dict(r) for r in linhas])


@app.route("/api/servidores", methods=["POST"])
@api_login
def api_criar_servidor():
    uid = usuario_atual()["id"]
    dados = request.get_json(silent=True) or {}
    nome = dados.get("nome", "").strip()
    molde = dados.get("molde", "padrao")
    if not nome:
        return jsonify({"erro": "Dê um nome ao servidor."}), 400
    with db.get_connection() as conn:
        sid = db.criar_servidor_completo(conn, nome, uid, molde)
    return jsonify({"id": sid, "nome": nome})


@app.route("/api/servidores/entrar", methods=["POST"])
@api_login
def api_entrar_servidor():
    uid = usuario_atual()["id"]
    convite = (request.get_json(silent=True) or {}).get("convite", "").strip().lower()
    with db.get_connection() as conn:
        srv = conn.execute("SELECT * FROM servidores WHERE convite=?", (convite,)).fetchone()
        if not srv:
            return jsonify({"erro": "Convite inválido."}), 404
        if eh_membro(conn, srv["id"], uid):
            return jsonify({"id": srv["id"], "nome": srv["nome"], "ja_era": True})
        banido = conn.execute(
            "SELECT 1 FROM banidos WHERE servidor_id=? AND usuario_id=?", (srv["id"], uid)
        ).fetchone()
        if banido:
            return jsonify({"erro": "Você foi banido deste servidor."}), 403
        conn.execute(
            "INSERT INTO membros (servidor_id, usuario_id, papel, entrou_em) VALUES (?,?,?,?)",
            (srv["id"], uid, "membro", db.agora()),
        )
    return jsonify({"id": srv["id"], "nome": srv["nome"]})


@app.route("/api/servidores/<int:sid>")
@api_login
def api_servidor_detalhe(sid):
    uid = usuario_atual()["id"]
    with db.get_connection() as conn:
        if not eh_membro(conn, sid, uid):
            return jsonify({"erro": "Você não é membro deste servidor."}), 403
        srv = conn.execute("SELECT * FROM servidores WHERE id=?", (sid,)).fetchone()
        cats = conn.execute(
            "SELECT * FROM categorias WHERE servidor_id=? ORDER BY ordem, id", (sid,)
        ).fetchall()
        canais_todos = conn.execute(
            "SELECT * FROM canais WHERE servidor_id=? ORDER BY ordem, id", (sid,)
        ).fetchall()
        canais = [c for c in canais_todos if db.pode_ver_canal(conn, c, sid, uid)]
        cargos = conn.execute(
            "SELECT * FROM cargos WHERE servidor_id=? ORDER BY ordem DESC", (sid,)
        ).fetchall()
        membros = conn.execute(
            """SELECT u.id, u.nome_exibicao AS nome, u.usuario, u.cor, m.papel
               FROM membros m JOIN usuarios u ON u.id = m.usuario_id
               WHERE m.servidor_id=? ORDER BY
                 CASE m.papel WHEN 'dono' THEN 0 ELSE 1 END, u.nome_exibicao""",
            (sid,),
        ).fetchall()
        cargos_por_membro = {}
        for row in conn.execute(
            """SELECT cm.usuario_id, c.id, c.nome, c.cor FROM cargo_membros cm
               JOIN cargos c ON c.id = cm.cargo_id WHERE c.servidor_id=?""", (sid,)):
            cargos_por_membro.setdefault(row["usuario_id"], []).append(
                {"id": row["id"], "nome": row["nome"], "cor": row["cor"]})
        minhas_permissoes = list(db.permissoes_do_membro(conn, sid, uid))
        sou_dono = db.eh_dono_servidor(conn, sid, uid)

    cats_out = []
    for c in cats:
        cats_out.append({
            "id": c["id"], "nome": c["nome"],
            "canais": [_serializar_canal(k) for k in canais if k["categoria_id"] == c["id"]],
        })
    sem_cat = [_serializar_canal(k) for k in canais if k["categoria_id"] is None]
    membros_out = []
    for m in membros:
        d = dict(m)
        d["cargos"] = cargos_por_membro.get(m["id"], [])
        membros_out.append(d)
    return jsonify({
        "id": srv["id"], "nome": srv["nome"], "convite": srv["convite"],
        "dono_id": srv["dono_id"],
        "categorias": cats_out, "sem_categoria": sem_cat,
        "membros": membros_out,
        "cargos": [dict(c) | {"permissoes": json.loads(c["permissoes"] or "[]")} for c in cargos],
        "minhas_permissoes": minhas_permissoes,
        "sou_dono": sou_dono,
    })


def _serializar_canal(c):
    d = dict(c)
    try:
        d["cargos_permitidos"] = json.loads(c["cargos_permitidos"]) if c["cargos_permitidos"] else []
    except (ValueError, TypeError):
        d["cargos_permitidos"] = []
    return d


@app.route("/api/servidores/<int:sid>/canais", methods=["POST"])
@api_login
def api_criar_canal(sid):
    uid = usuario_atual()["id"]
    dados = request.get_json(silent=True) or {}
    nome = dados.get("nome", "").strip().lower().replace(" ", "-")
    categoria_id = dados.get("categoria_id")
    if not nome:
        return jsonify({"erro": "Dê um nome ao canal."}), 400
    with db.get_connection() as conn:
        if not eh_membro(conn, sid, uid):
            return jsonify({"erro": "Você não é membro deste servidor."}), 403
        if not db.tem_permissao(conn, sid, uid, "gerenciar_canais"):
            return jsonify({"erro": "Você não tem permissão para gerenciar canais."}), 403
        cid = db.inserir(conn,
            "INSERT INTO canais (servidor_id, categoria_id, nome, ordem, criado_em) VALUES (?,?,?,?,?)",
            (sid, categoria_id, nome, 99, db.agora()),
        )
        registrar_notificacao_geral(conn, sid, uid, f"criou o canal #{nome}")
    return jsonify({"id": cid, "nome": nome, "categoria_id": categoria_id})


@app.route("/api/canais/<int:cid>", methods=["PUT"])
@api_login
def api_editar_canal(cid):
    uid = usuario_atual()["id"]
    dados = request.get_json(silent=True) or {}
    with db.get_connection() as conn:
        canal = conn.execute("SELECT * FROM canais WHERE id=?", (cid,)).fetchone()
        if not canal:
            return jsonify({"erro": "Canal não encontrado."}), 404
        sid = canal["servidor_id"]
        if not db.tem_permissao(conn, sid, uid, "gerenciar_canais"):
            return jsonify({"erro": "Você não tem permissão para gerenciar canais."}), 403
        nome = dados.get("nome", canal["nome"]).strip().lower().replace(" ", "-") or canal["nome"]
        descricao = dados.get("descricao", canal["descricao"] or "")
        cargos_permitidos = dados.get("cargos_permitidos")
        cargos_json = json.dumps(cargos_permitidos) if cargos_permitidos else None
        conn.execute(
            "UPDATE canais SET nome=?, descricao=?, cargos_permitidos=? WHERE id=?",
            (nome, descricao, cargos_json, cid),
        )
    return jsonify({"ok": True})


@app.route("/api/canais/<int:cid>", methods=["DELETE"])
@api_login
def api_excluir_canal(cid):
    uid = usuario_atual()["id"]
    with db.get_connection() as conn:
        canal = conn.execute("SELECT * FROM canais WHERE id=?", (cid,)).fetchone()
        if not canal:
            return jsonify({"erro": "Canal não encontrado."}), 404
        if not db.tem_permissao(conn, canal["servidor_id"], uid, "gerenciar_canais"):
            return jsonify({"erro": "Você não tem permissão para gerenciar canais."}), 403
        conn.execute("DELETE FROM canais WHERE id=?", (cid,))
    return jsonify({"ok": True})


@app.route("/api/servidores/<int:sid>/categorias", methods=["POST"])
@api_login
def api_criar_categoria(sid):
    uid = usuario_atual()["id"]
    nome = (request.get_json(silent=True) or {}).get("nome", "").strip()
    if not nome:
        return jsonify({"erro": "Dê um nome à categoria."}), 400
    with db.get_connection() as conn:
        if not db.tem_permissao(conn, sid, uid, "gerenciar_canais"):
            return jsonify({"erro": "Você não tem permissão para gerenciar canais."}), 403
        prox = conn.execute("SELECT COALESCE(MAX(ordem),-1)+1 AS o FROM categorias WHERE servidor_id=?", (sid,)).fetchone()["o"]
        cat_id = db.inserir(conn,
            "INSERT INTO categorias (servidor_id, nome, ordem) VALUES (?,?,?)", (sid, nome, prox))
    return jsonify({"id": cat_id, "nome": nome})


@app.route("/api/categorias/<int:cat_id>", methods=["DELETE"])
@api_login
def api_excluir_categoria(cat_id):
    uid = usuario_atual()["id"]
    with db.get_connection() as conn:
        cat = conn.execute("SELECT * FROM categorias WHERE id=?", (cat_id,)).fetchone()
        if not cat:
            return jsonify({"erro": "Categoria não encontrada."}), 404
        if not db.tem_permissao(conn, cat["servidor_id"], uid, "gerenciar_canais"):
            return jsonify({"erro": "Você não tem permissão para gerenciar canais."}), 403
        conn.execute("DELETE FROM categorias WHERE id=?", (cat_id,))
    return jsonify({"ok": True})


# ==================== API: CARGOS E PERMISSÕES ====================

@app.route("/api/permissoes")
@api_login
def api_lista_permissoes():
    return jsonify([{"chave": k, "rotulo": r} for k, r in db.PERMISSOES])


@app.route("/api/servidores/<int:sid>/cargos", methods=["POST"])
@api_login
def api_criar_cargo(sid):
    uid = usuario_atual()["id"]
    dados = request.get_json(silent=True) or {}
    nome = dados.get("nome", "").strip()
    cor = dados.get("cor", "#99aab5")
    permissoes = [p for p in (dados.get("permissoes") or []) if p in db.CHAVES_PERMISSOES]
    if not nome:
        return jsonify({"erro": "Dê um nome ao cargo."}), 400
    with db.get_connection() as conn:
        if not eh_membro(conn, sid, uid):
            return jsonify({"erro": "Você não é membro deste servidor."}), 403
        if not db.tem_permissao(conn, sid, uid, "gerenciar_cargos"):
            return jsonify({"erro": "Você não tem permissão para gerenciar cargos."}), 403
        # um cargo novo nasce numa posição abaixo da posição do criador (a não ser que seja o dono)
        minha_posicao = db.posicao_do_membro(conn, sid, uid)
        maior = conn.execute("SELECT COALESCE(MAX(ordem),-1) AS o FROM cargos WHERE servidor_id=?", (sid,)).fetchone()["o"]
        nova_ordem = maior + 1
        if not db.eh_dono_servidor(conn, sid, uid) and nova_ordem >= minha_posicao:
            nova_ordem = minha_posicao  # nunca cria cargo na sua própria posição ou acima
        cargo_id = db.inserir(conn,
            "INSERT INTO cargos (servidor_id, nome, cor, ordem, permissoes, criado_em) VALUES (?,?,?,?,?,?)",
            (sid, nome, cor, nova_ordem, json.dumps(permissoes), db.agora()),
        )
    return jsonify({"id": cargo_id, "nome": nome, "cor": cor, "ordem": nova_ordem, "permissoes": permissoes})


@app.route("/api/cargos/<int:cargo_id>", methods=["PUT"])
@api_login
def api_editar_cargo(cargo_id):
    uid = usuario_atual()["id"]
    dados = request.get_json(silent=True) or {}
    with db.get_connection() as conn:
        cargo = conn.execute("SELECT * FROM cargos WHERE id=?", (cargo_id,)).fetchone()
        if not cargo:
            return jsonify({"erro": "Cargo não encontrado."}), 404
        sid = cargo["servidor_id"]
        if not db.tem_permissao(conn, sid, uid, "gerenciar_cargos"):
            return jsonify({"erro": "Você não tem permissão para gerenciar cargos."}), 403
        if not db.pode_gerenciar_cargo(conn, sid, uid, cargo):
            return jsonify({"erro": "Você não pode editar um cargo igual ou acima do seu."}), 403
        nome = dados.get("nome", cargo["nome"]).strip() or cargo["nome"]
        cor = dados.get("cor", cargo["cor"])
        permissoes = dados.get("permissoes")
        if permissoes is not None:
            permissoes = [p for p in permissoes if p in db.CHAVES_PERMISSOES]
        else:
            permissoes = json.loads(cargo["permissoes"] or "[]")
        conn.execute(
            "UPDATE cargos SET nome=?, cor=?, permissoes=? WHERE id=?",
            (nome, cor, json.dumps(permissoes), cargo_id),
        )
    return jsonify({"ok": True})


@app.route("/api/cargos/<int:cargo_id>", methods=["DELETE"])
@api_login
def api_excluir_cargo(cargo_id):
    uid = usuario_atual()["id"]
    with db.get_connection() as conn:
        cargo = conn.execute("SELECT * FROM cargos WHERE id=?", (cargo_id,)).fetchone()
        if not cargo:
            return jsonify({"erro": "Cargo não encontrado."}), 404
        if not db.tem_permissao(conn, cargo["servidor_id"], uid, "gerenciar_cargos"):
            return jsonify({"erro": "Você não tem permissão para gerenciar cargos."}), 403
        if not db.pode_gerenciar_cargo(conn, cargo["servidor_id"], uid, cargo):
            return jsonify({"erro": "Você não pode excluir um cargo igual ou acima do seu."}), 403
        conn.execute("DELETE FROM cargos WHERE id=?", (cargo_id,))
    return jsonify({"ok": True})


@app.route("/api/cargos/<int:cargo_id>/membros/<int:alvo_id>", methods=["POST"])
@api_login
def api_atribuir_cargo(cargo_id, alvo_id):
    uid = usuario_atual()["id"]
    with db.get_connection() as conn:
        cargo = conn.execute("SELECT * FROM cargos WHERE id=?", (cargo_id,)).fetchone()
        if not cargo:
            return jsonify({"erro": "Cargo não encontrado."}), 404
        sid = cargo["servidor_id"]
        if not eh_membro(conn, sid, alvo_id):
            return jsonify({"erro": "Usuário não é membro deste servidor."}), 404
        if not db.tem_permissao(conn, sid, uid, "gerenciar_cargos"):
            return jsonify({"erro": "Você não tem permissão para gerenciar cargos."}), 403
        if not db.pode_gerenciar_cargo(conn, sid, uid, cargo):
            return jsonify({"erro": "Você não pode atribuir um cargo igual ou acima do seu."}), 403
        existe = conn.execute(
            "SELECT 1 FROM cargo_membros WHERE cargo_id=? AND usuario_id=?", (cargo_id, alvo_id)
        ).fetchone()
        if not existe:
            conn.execute(
                "INSERT INTO cargo_membros (cargo_id, usuario_id) VALUES (?,?)", (cargo_id, alvo_id))
    return jsonify({"ok": True})


@app.route("/api/cargos/<int:cargo_id>/membros/<int:alvo_id>", methods=["DELETE"])
@api_login
def api_remover_cargo_membro(cargo_id, alvo_id):
    uid = usuario_atual()["id"]
    with db.get_connection() as conn:
        cargo = conn.execute("SELECT * FROM cargos WHERE id=?", (cargo_id,)).fetchone()
        if not cargo:
            return jsonify({"erro": "Cargo não encontrado."}), 404
        sid = cargo["servidor_id"]
        if not db.tem_permissao(conn, sid, uid, "gerenciar_cargos"):
            return jsonify({"erro": "Você não tem permissão para gerenciar cargos."}), 403
        if not db.pode_gerenciar_cargo(conn, sid, uid, cargo):
            return jsonify({"erro": "Você não pode remover um cargo igual ou acima do seu."}), 403
        conn.execute("DELETE FROM cargo_membros WHERE cargo_id=? AND usuario_id=?", (cargo_id, alvo_id))
    return jsonify({"ok": True})


# ==================== API: MODERAÇÃO (expulsar / banir) ====================

@app.route("/api/servidores/<int:sid>/membros/<int:alvo_id>/expulsar", methods=["POST"])
@api_login
def api_expulsar_membro(sid, alvo_id):
    uid = usuario_atual()["id"]
    with db.get_connection() as conn:
        if not eh_membro(conn, sid, alvo_id):
            return jsonify({"erro": "Usuário não é membro deste servidor."}), 404
        if not db.tem_permissao(conn, sid, uid, "expulsar_membros"):
            return jsonify({"erro": "Você não tem permissão para expulsar membros."}), 403
        if not db.pode_agir_sobre_membro(conn, sid, uid, alvo_id):
            return jsonify({"erro": "Você não pode expulsar este membro."}), 403
        conn.execute("DELETE FROM membros WHERE servidor_id=? AND usuario_id=?", (sid, alvo_id))
        conn.execute(
            "DELETE FROM cargo_membros WHERE usuario_id=? AND cargo_id IN (SELECT id FROM cargos WHERE servidor_id=?)",
            (alvo_id, sid),
        )
    _notificar_usuario(alvo_id, "expulso_do_servidor", {"servidor_id": sid})
    return jsonify({"ok": True})


@app.route("/api/servidores/<int:sid>/membros/<int:alvo_id>/banir", methods=["POST"])
@api_login
def api_banir_membro(sid, alvo_id):
    uid = usuario_atual()["id"]
    motivo = (request.get_json(silent=True) or {}).get("motivo", "").strip()
    with db.get_connection() as conn:
        if not eh_membro(conn, sid, alvo_id):
            return jsonify({"erro": "Usuário não é membro deste servidor."}), 404
        if not db.tem_permissao(conn, sid, uid, "banir_membros"):
            return jsonify({"erro": "Você não tem permissão para banir membros."}), 403
        if not db.pode_agir_sobre_membro(conn, sid, uid, alvo_id):
            return jsonify({"erro": "Você não pode banir este membro."}), 403
        conn.execute("DELETE FROM membros WHERE servidor_id=? AND usuario_id=?", (sid, alvo_id))
        conn.execute(
            "DELETE FROM cargo_membros WHERE usuario_id=? AND cargo_id IN (SELECT id FROM cargos WHERE servidor_id=?)",
            (alvo_id, sid),
        )
        existe = conn.execute("SELECT 1 FROM banidos WHERE servidor_id=? AND usuario_id=?", (sid, alvo_id)).fetchone()
        if not existe:
            conn.execute(
                "INSERT INTO banidos (servidor_id, usuario_id, motivo, criado_em) VALUES (?,?,?,?)",
                (sid, alvo_id, motivo, db.agora()),
            )
    _notificar_usuario(alvo_id, "banido_do_servidor", {"servidor_id": sid})
    return jsonify({"ok": True})


@app.route("/api/servidores/<int:sid>/banidos")
@api_login
def api_lista_banidos(sid):
    uid = usuario_atual()["id"]
    with db.get_connection() as conn:
        if not db.tem_permissao(conn, sid, uid, "banir_membros"):
            return jsonify({"erro": "Você não tem permissão para ver banidos."}), 403
        linhas = conn.execute(
            """SELECT b.usuario_id AS id, u.nome_exibicao AS nome, u.usuario, b.motivo, b.criado_em
               FROM banidos b JOIN usuarios u ON u.id = b.usuario_id WHERE b.servidor_id=?""",
            (sid,),
        ).fetchall()
    return jsonify([dict(r) for r in linhas])


@app.route("/api/servidores/<int:sid>/banidos/<int:alvo_id>", methods=["DELETE"])
@api_login
def api_desbanir_membro(sid, alvo_id):
    uid = usuario_atual()["id"]
    with db.get_connection() as conn:
        if not db.tem_permissao(conn, sid, uid, "banir_membros"):
            return jsonify({"erro": "Você não tem permissão para desbanir."}), 403
        conn.execute("DELETE FROM banidos WHERE servidor_id=? AND usuario_id=?", (sid, alvo_id))
    return jsonify({"ok": True})


def registrar_notificacao_geral(conn, sid, autor_id, texto):
    pass  # gancho reservado para notificações futuras de atividade do servidor


# ==================== API: AMIGOS ====================

def _serializar_amigo(row, extra=None):
    d = {"id": row["id"], "usuario": row["usuario"], "nome": row["nome_exibicao"], "cor": row["cor"]}
    if extra:
        d.update(extra)
    return d


@app.route("/api/amigos")
@api_login
def api_amigos():
    uid = usuario_atual()["id"]
    with db.get_connection() as conn:
        aceitas = conn.execute(
            """SELECT u.id, u.usuario, u.nome_exibicao, u.cor FROM amizades a
               JOIN usuarios u ON u.id = (CASE WHEN a.solicitante_id=? THEN a.destinatario_id ELSE a.solicitante_id END)
               WHERE a.status='aceita' AND (a.solicitante_id=? OR a.destinatario_id=?)
               ORDER BY u.nome_exibicao""",
            (uid, uid, uid),
        ).fetchall()
        recebidos = conn.execute(
            """SELECT a.id AS pedido_id, u.id, u.usuario, u.nome_exibicao, u.cor, a.criado_em
               FROM amizades a JOIN usuarios u ON u.id = a.solicitante_id
               WHERE a.destinatario_id=? AND a.status='pendente' ORDER BY a.criado_em""",
            (uid,),
        ).fetchall()
        enviados = conn.execute(
            """SELECT a.id AS pedido_id, u.id, u.usuario, u.nome_exibicao, u.cor, a.criado_em
               FROM amizades a JOIN usuarios u ON u.id = a.destinatario_id
               WHERE a.solicitante_id=? AND a.status='pendente' ORDER BY a.criado_em""",
            (uid,),
        ).fetchall()
        bloqueados = conn.execute(
            """SELECT u.id, u.usuario, u.nome_exibicao, u.cor FROM bloqueios b
               JOIN usuarios u ON u.id = b.bloqueado_id WHERE b.usuario_id=? ORDER BY u.nome_exibicao""",
            (uid,),
        ).fetchall()
    return jsonify({
        "amigos": [_serializar_amigo(r, {"online": _online.get(r["id"], 0) > 0}) for r in aceitas],
        "recebidos": [_serializar_amigo(r, {"pedido_id": r["pedido_id"]}) for r in recebidos],
        "enviados": [_serializar_amigo(r, {"pedido_id": r["pedido_id"]}) for r in enviados],
        "bloqueados": [_serializar_amigo(r) for r in bloqueados],
    })


@app.route("/api/amigos/solicitar", methods=["POST"])
@api_login
def api_amigos_solicitar():
    uid = usuario_atual()["id"]
    usuario_alvo = (request.get_json(silent=True) or {}).get("usuario", "").strip().lower().lstrip("@")
    if not usuario_alvo:
        return jsonify({"erro": "Informe um nome de usuário."}), 400
    with db.get_connection() as conn:
        alvo = conn.execute("SELECT id FROM usuarios WHERE usuario=?", (usuario_alvo,)).fetchone()
        if not alvo:
            return jsonify({"erro": f"Não encontramos ninguém com o usuário \"{usuario_alvo}\"."}), 404
        if alvo["id"] == uid:
            return jsonify({"erro": "Você não pode adicionar a si mesmo."}), 400
        if db.existe_bloqueio(conn, uid, alvo["id"]):
            return jsonify({"erro": "Não é possível enviar pedido para este usuário."}), 403
        if db.sao_amigos(conn, uid, alvo["id"]):
            return jsonify({"erro": "Vocês já são amigos."}), 400
        existente = conn.execute(
            """SELECT * FROM amizades WHERE
               (solicitante_id=? AND destinatario_id=?) OR (solicitante_id=? AND destinatario_id=?)""",
            (uid, alvo["id"], alvo["id"], uid),
        ).fetchone()
        if existente and existente["status"] == "pendente":
            if existente["solicitante_id"] == uid:
                return jsonify({"erro": "Você já enviou um pedido para este usuário."}), 400
            # o outro já tinha te chamado -> aceita automaticamente
            conn.execute("UPDATE amizades SET status='aceita', respondido_em=? WHERE id=?",
                         (db.agora(), existente["id"]))
            _notificar_usuario(alvo["id"], "pedido_aceito", {})
            _notificar_usuario(uid, "pedido_aceito", {})
            return jsonify({"ok": True, "status": "aceita"})
        if existente:
            conn.execute("UPDATE amizades SET status='pendente', solicitante_id=?, destinatario_id=?, criado_em=? WHERE id=?",
                         (uid, alvo["id"], db.agora(), existente["id"]))
        else:
            db.inserir(conn,
                "INSERT INTO amizades (solicitante_id, destinatario_id, status, criado_em) VALUES (?,?,?,?)",
                (uid, alvo["id"], "pendente", db.agora()),
            )
    _notificar_usuario(alvo["id"], "novo_pedido_amizade", {})
    return jsonify({"ok": True, "status": "pendente"})


@app.route("/api/amigos/<int:pedido_id>/responder", methods=["POST"])
@api_login
def api_amigos_responder(pedido_id):
    uid = usuario_atual()["id"]
    aceitar = bool((request.get_json(silent=True) or {}).get("aceitar"))
    with db.get_connection() as conn:
        p = conn.execute("SELECT * FROM amizades WHERE id=? AND destinatario_id=?", (pedido_id, uid)).fetchone()
        if not p or p["status"] != "pendente":
            return jsonify({"erro": "Pedido não encontrado."}), 404
        novo_status = "aceita" if aceitar else "recusada"
        conn.execute("UPDATE amizades SET status=?, respondido_em=? WHERE id=?", (novo_status, db.agora(), pedido_id))
        outro_id = p["solicitante_id"]
    _notificar_usuario(outro_id, "pedido_aceito" if aceitar else "pedido_recusado", {})
    return jsonify({"ok": True})


@app.route("/api/amigos/<int:amigo_id>/remover", methods=["POST"])
@api_login
def api_amigos_remover(amigo_id):
    uid = usuario_atual()["id"]
    with db.get_connection() as conn:
        conn.execute(
            """DELETE FROM amizades WHERE
               (solicitante_id=? AND destinatario_id=?) OR (solicitante_id=? AND destinatario_id=?)""",
            (uid, amigo_id, amigo_id, uid),
        )
    _notificar_usuario(amigo_id, "amigo_removido", {})
    return jsonify({"ok": True})


@app.route("/api/amigos/<int:alvo_id>/bloquear", methods=["POST"])
@api_login
def api_amigos_bloquear(alvo_id):
    uid = usuario_atual()["id"]
    with db.get_connection() as conn:
        conn.execute(
            """DELETE FROM amizades WHERE
               (solicitante_id=? AND destinatario_id=?) OR (solicitante_id=? AND destinatario_id=?)""",
            (uid, alvo_id, alvo_id, uid),
        )
        existe = conn.execute("SELECT 1 FROM bloqueios WHERE usuario_id=? AND bloqueado_id=?", (uid, alvo_id)).fetchone()
        if not existe:
            conn.execute(
                "INSERT INTO bloqueios (usuario_id, bloqueado_id, criado_em) VALUES (?,?,?)",
                (uid, alvo_id, db.agora()),
            )
    return jsonify({"ok": True})


@app.route("/api/amigos/<int:alvo_id>/desbloquear", methods=["POST"])
@api_login
def api_amigos_desbloquear(alvo_id):
    uid = usuario_atual()["id"]
    with db.get_connection() as conn:
        conn.execute("DELETE FROM bloqueios WHERE usuario_id=? AND bloqueado_id=?", (uid, alvo_id))
    return jsonify({"ok": True})


# ==================== API: MENSAGENS DIRETAS (DM) ====================

@app.route("/api/dm/conversas")
@api_login
def api_dm_conversas():
    uid = usuario_atual()["id"]
    with db.get_connection() as conn:
        linhas = conn.execute(
            """SELECT c.id AS conversa_id, u.id, u.usuario, u.nome_exibicao, u.cor,
                      (SELECT conteudo FROM mensagens_dm WHERE conversa_id=c.id ORDER BY id DESC LIMIT 1) ultima,
                      (SELECT criado_em FROM mensagens_dm WHERE conversa_id=c.id ORDER BY id DESC LIMIT 1) ultima_em,
                      (SELECT COUNT(*) FROM mensagens_dm WHERE conversa_id=c.id AND autor_id!=? AND lida=0) nao_lidas
               FROM conversas_dm c
               JOIN usuarios u ON u.id = (CASE WHEN c.usuario_a_id=? THEN c.usuario_b_id ELSE c.usuario_a_id END)
               WHERE c.usuario_a_id=? OR c.usuario_b_id=?
               ORDER BY ultima_em DESC NULLS LAST""",
            (uid, uid, uid, uid),
        ).fetchall()
    out = []
    for r in linhas:
        out.append({
            "conversa_id": r["conversa_id"], "id": r["id"], "usuario": r["usuario"],
            "nome": r["nome_exibicao"], "cor": r["cor"], "ultima": r["ultima"],
            "ultima_em": r["ultima_em"], "nao_lidas": r["nao_lidas"],
            "online": _online.get(r["id"], 0) > 0,
        })
    return jsonify(out)


@app.route("/api/dm/abrir/<int:amigo_id>", methods=["POST"])
@api_login
def api_dm_abrir(amigo_id):
    uid = usuario_atual()["id"]
    with db.get_connection() as conn:
        if not db.sao_amigos(conn, uid, amigo_id):
            return jsonify({"erro": "Vocês precisam ser amigos para conversar."}), 403
        cid = db.obter_ou_criar_conversa(conn, uid, amigo_id)
    return jsonify({"conversa_id": cid})


@app.route("/api/dm/<int:cid>/mensagens")
@api_login
def api_dm_mensagens(cid):
    uid = usuario_atual()["id"]
    with db.get_connection() as conn:
        conv = conn.execute("SELECT * FROM conversas_dm WHERE id=?", (cid,)).fetchone()
        if not conv or uid not in (conv["usuario_a_id"], conv["usuario_b_id"]):
            return jsonify({"erro": "Sem acesso a esta conversa."}), 403
        conn.execute("UPDATE mensagens_dm SET lida=1 WHERE conversa_id=? AND autor_id!=?", (cid, uid))
        linhas = conn.execute(
            """SELECT m.id, m.conteudo, m.criado_em, m.editada, m.responde_a,
                      u.nome_exibicao AS autor, u.usuario, u.cor, u.id AS autor_id
               FROM mensagens_dm m JOIN usuarios u ON u.id = m.autor_id
               WHERE m.conversa_id=? ORDER BY m.id DESC LIMIT 50""",
            (cid,),
        ).fetchall()
        linhas = list(reversed(linhas))
        # citações (reaproveita a lógica de mensagens de servidor, mas na tabela de DM)
        resp_ids = [r["responde_a"] for r in linhas if r["responde_a"]]
        respondidas = {}
        if resp_ids:
            marc = ",".join("?" * len(resp_ids))
            for r in conn.execute(
                f"""SELECT m.id, m.conteudo, u.nome_exibicao AS autor FROM mensagens_dm m
                    JOIN usuarios u ON u.id=m.autor_id WHERE m.id IN ({marc})""", list(resp_ids)):
                respondidas[r["id"]] = {"autor": r["autor"], "conteudo": r["conteudo"]}
    out = []
    for r in linhas:
        out.append({
            "id": r["id"], "conteudo": r["conteudo"], "criado_em": r["criado_em"],
            "autor": r["autor"], "usuario": r["usuario"], "cor": r["cor"], "autor_id": r["autor_id"],
            "editada": bool(r["editada"]), "responde_a": r["responde_a"],
            "resposta": respondidas.get(r["responde_a"]),
        })
    return jsonify(out)


def _notificar_usuario(uid, tipo, dados):
    """Emite um evento para todas as conexões abertas de um usuário (se online)."""
    socketio.emit(tipo, dados, room=f"usuario_{uid}")


# ==================== API: MENSAGENS DE SERVIDOR ====================

def _reacoes_de(conn, ids, uid):
    """Retorna {mensagem_id: [{emoji, total, eu}]} para uma lista de mensagens."""
    if not ids:
        return {}
    marc = ",".join("?" * len(ids))
    linhas = conn.execute(
        f"""SELECT mensagem_id, emoji, COUNT(*) total,
                   MAX(CASE WHEN usuario_id=? THEN 1 ELSE 0 END) eu
            FROM reacoes WHERE mensagem_id IN ({marc})
            GROUP BY mensagem_id, emoji ORDER BY emoji""",
        [uid] + list(ids),
    ).fetchall()
    out = {}
    for r in linhas:
        out.setdefault(r["mensagem_id"], []).append(
            {"emoji": r["emoji"], "total": r["total"], "eu": bool(r["eu"])}
        )
    return out


def _serializar_mensagens(conn, linhas, uid):
    ids = [r["id"] for r in linhas]
    reacoes = _reacoes_de(conn, ids, uid)
    # mapa de mensagens respondidas (para mostrar a citação)
    resp_ids = [r["responde_a"] for r in linhas if r["responde_a"]]
    respondidas = {}
    if resp_ids:
        marc = ",".join("?" * len(resp_ids))
        for r in conn.execute(
            f"""SELECT m.id, m.conteudo, u.nome_exibicao AS autor
                FROM mensagens m JOIN usuarios u ON u.id=m.autor_id
                WHERE m.id IN ({marc})""", list(resp_ids)):
            respondidas[r["id"]] = {"autor": r["autor"], "conteudo": r["conteudo"]}
    out = []
    for r in linhas:
        out.append({
            "id": r["id"], "conteudo": r["conteudo"], "criado_em": r["criado_em"],
            "autor": r["autor"], "usuario": r["usuario"], "cor": r["cor"],
            "autor_id": r["autor_id"], "editada": bool(r["editada"]),
            "responde_a": r["responde_a"],
            "resposta": respondidas.get(r["responde_a"]),
            "reacoes": reacoes.get(r["id"], []),
        })
    return out


@app.route("/api/canais/<int:cid>/mensagens")
@api_login
def api_mensagens(cid):
    uid = usuario_atual()["id"]
    with db.get_connection() as conn:
        if not canal_do_usuario(conn, cid, uid):
            return jsonify({"erro": "Sem acesso a este canal."}), 403
        linhas = conn.execute(
            """SELECT msg.id, msg.conteudo, msg.criado_em, msg.editada, msg.responde_a,
                      u.nome_exibicao AS autor, u.usuario, u.cor, u.id AS autor_id
               FROM mensagens msg JOIN usuarios u ON u.id = msg.autor_id
               WHERE msg.canal_id=? ORDER BY msg.id DESC LIMIT 50""",
            (cid,),
        ).fetchall()
        linhas = list(reversed(linhas))
        dados = _serializar_mensagens(conn, linhas, uid)
    return jsonify(dados)


# ==================== WEBSOCKET (tempo real) ====================

@socketio.on("connect")
def ws_connect():
    if not logado():
        return
    uid = usuario_atual()["id"]
    join_room(f"usuario_{uid}")
    ficou_online = _online.get(uid, 0) == 0
    _online[uid] = _online.get(uid, 0) + 1
    if ficou_online:
        _avisar_amigos_status(uid, True)


@socketio.on("disconnect")
def ws_disconnect():
    if not logado():
        return
    uid = usuario_atual()["id"]
    if uid in _online:
        _online[uid] = max(0, _online[uid] - 1)
        if _online[uid] == 0:
            del _online[uid]
            _avisar_amigos_status(uid, False)
    _sair_de_todas_chamadas(uid)


def _avisar_amigos_status(uid, online):
    with db.get_connection() as conn:
        amigos = conn.execute(
            """SELECT (CASE WHEN solicitante_id=? THEN destinatario_id ELSE solicitante_id END) AS amigo_id
               FROM amizades WHERE status='aceita' AND (solicitante_id=? OR destinatario_id=?)""",
            (uid, uid, uid),
        ).fetchall()
    for a in amigos:
        socketio.emit("amigo_status", {"usuario_id": uid, "online": online}, room=f"usuario_{a['amigo_id']}")


@socketio.on("entrar_canal")
def ws_entrar_canal(data):
    if not logado():
        return
    cid = data.get("canal_id")
    with db.get_connection() as conn:
        if not canal_do_usuario(conn, cid, usuario_atual()["id"]):
            return
    join_room(f"canal_{cid}")


@socketio.on("sair_canal")
def ws_sair_canal(data):
    cid = data.get("canal_id")
    if cid is not None:
        leave_room(f"canal_{cid}")


@socketio.on("enviar_mensagem")
def ws_enviar_mensagem(data):
    if not logado():
        return
    u = usuario_atual()
    cid = data.get("canal_id")
    conteudo = (data.get("conteudo") or "").strip()
    responde_a = data.get("responde_a")
    if not conteudo:
        return
    conteudo = conteudo[:2000]  # limite de tamanho
    with db.get_connection() as conn:
        if not canal_do_usuario(conn, cid, u["id"]):
            return
        # valida que a mensagem respondida é do mesmo canal
        if responde_a:
            alvo = conn.execute("SELECT canal_id FROM mensagens WHERE id=?", (responde_a,)).fetchone()
            if not alvo or alvo["canal_id"] != cid:
                responde_a = None
        quando = db.agora()
        mid = db.inserir(conn,
            "INSERT INTO mensagens (canal_id, autor_id, conteudo, responde_a, criado_em) VALUES (?,?,?,?,?)",
            (cid, u["id"], conteudo, responde_a, quando),
        )
        resposta = None
        if responde_a:
            r = conn.execute(
                """SELECT m.conteudo, us.nome_exibicao AS autor FROM mensagens m
                   JOIN usuarios us ON us.id=m.autor_id WHERE m.id=?""", (responde_a,)).fetchone()
            if r:
                resposta = {"autor": r["autor"], "conteudo": r["conteudo"]}
    emit("nova_mensagem", {
        "id": mid, "canal_id": cid, "conteudo": conteudo,
        "autor": u["nome"], "usuario": u["usuario"], "cor": u["cor"],
        "autor_id": u["id"], "criado_em": quando, "editada": False,
        "responde_a": responde_a, "resposta": resposta, "reacoes": [],
    }, room=f"canal_{cid}")


@socketio.on("editar_mensagem")
def ws_editar_mensagem(data):
    if not logado():
        return
    u = usuario_atual()
    mid = data.get("id")
    novo = (data.get("conteudo") or "").strip()[:2000]
    if not novo:
        return
    with db.get_connection() as conn:
        m = conn.execute("SELECT * FROM mensagens WHERE id=?", (mid,)).fetchone()
        if not m or m["autor_id"] != u["id"]:
            return  # só o autor edita
        conn.execute("UPDATE mensagens SET conteudo=?, editada=1 WHERE id=?", (novo, mid))
        cid = m["canal_id"]
    emit("mensagem_editada", {"id": mid, "canal_id": cid, "conteudo": novo}, room=f"canal_{cid}")


@socketio.on("apagar_mensagem")
def ws_apagar_mensagem(data):
    if not logado():
        return
    u = usuario_atual()
    mid = data.get("id")
    with db.get_connection() as conn:
        m = conn.execute("SELECT * FROM mensagens WHERE id=?", (mid,)).fetchone()
        if not m:
            return
        # autor apaga a própria; quem tem 'gerenciar_mensagens' no servidor também pode
        pode = (m["autor_id"] == u["id"])
        if not pode:
            canal = conn.execute("SELECT servidor_id FROM canais WHERE id=?", (m["canal_id"],)).fetchone()
            if canal:
                pode = db.tem_permissao(conn, canal["servidor_id"], u["id"], "gerenciar_mensagens")
        if not pode:
            return
        cid = m["canal_id"]
        conn.execute("DELETE FROM mensagens WHERE id=?", (mid,))
    emit("mensagem_apagada", {"id": mid, "canal_id": cid}, room=f"canal_{cid}")


@socketio.on("alternar_reacao")
def ws_alternar_reacao(data):
    if not logado():
        return
    u = usuario_atual()
    mid = data.get("id")
    emoji = (data.get("emoji") or "").strip()[:8]
    if not emoji:
        return
    with db.get_connection() as conn:
        m = conn.execute("SELECT canal_id FROM mensagens WHERE id=?", (mid,)).fetchone()
        if not m or not canal_do_usuario(conn, m["canal_id"], u["id"]):
            return
        ja = conn.execute(
            "SELECT id FROM reacoes WHERE mensagem_id=? AND usuario_id=? AND emoji=?",
            (mid, u["id"], emoji)).fetchone()
        if ja:
            conn.execute("DELETE FROM reacoes WHERE id=?", (ja["id"],))
        else:
            conn.execute(
                "INSERT INTO reacoes (mensagem_id, usuario_id, emoji) VALUES (?,?,?)",
                (mid, u["id"], emoji))
        cid = m["canal_id"]
        # recomputa os totais desse emoji nessa mensagem
        tot = conn.execute(
            "SELECT COUNT(*) c FROM reacoes WHERE mensagem_id=? AND emoji=?", (mid, emoji)).fetchone()["c"]
    emit("reacao_atualizada", {
        "id": mid, "canal_id": cid, "emoji": emoji, "total": tot,
        "por_usuario": u["id"], "adicionou": not ja,
    }, room=f"canal_{cid}")


@socketio.on("digitando")
def ws_digitando(data):
    if not logado():
        return
    u = usuario_atual()
    cid = data.get("canal_id")
    emit("usuario_digitando", {"canal_id": cid, "nome": u["nome"]},
         room=f"canal_{cid}", include_self=False)


# ---------------- Mensagens diretas (DM) ----------------

def _acesso_conversa(conn, cid, uid):
    conv = conn.execute("SELECT * FROM conversas_dm WHERE id=?", (cid,)).fetchone()
    if not conv or uid not in (conv["usuario_a_id"], conv["usuario_b_id"]):
        return None
    return conv


@socketio.on("entrar_dm")
def ws_entrar_dm(data):
    if not logado():
        return
    cid = data.get("conversa_id")
    with db.get_connection() as conn:
        if not _acesso_conversa(conn, cid, usuario_atual()["id"]):
            return
    join_room(f"dm_{cid}")


@socketio.on("sair_dm")
def ws_sair_dm(data):
    cid = data.get("conversa_id")
    if cid is not None:
        leave_room(f"dm_{cid}")


@socketio.on("enviar_dm")
def ws_enviar_dm(data):
    if not logado():
        return
    u = usuario_atual()
    cid = data.get("conversa_id")
    conteudo = (data.get("conteudo") or "").strip()[:2000]
    responde_a = data.get("responde_a")
    if not conteudo:
        return
    with db.get_connection() as conn:
        conv = _acesso_conversa(conn, cid, u["id"])
        if not conv:
            return
        outro_id = conv["usuario_b_id"] if conv["usuario_a_id"] == u["id"] else conv["usuario_a_id"]
        if db.existe_bloqueio(conn, u["id"], outro_id):
            return
        if responde_a:
            alvo = conn.execute("SELECT conversa_id FROM mensagens_dm WHERE id=?", (responde_a,)).fetchone()
            if not alvo or alvo["conversa_id"] != cid:
                responde_a = None
        quando = db.agora()
        mid = db.inserir(conn,
            "INSERT INTO mensagens_dm (conversa_id, autor_id, conteudo, responde_a, criado_em) VALUES (?,?,?,?,?)",
            (cid, u["id"], conteudo, responde_a, quando),
        )
        resposta = None
        if responde_a:
            r = conn.execute(
                """SELECT m.conteudo, us.nome_exibicao AS autor FROM mensagens_dm m
                   JOIN usuarios us ON us.id=m.autor_id WHERE m.id=?""", (responde_a,)).fetchone()
            if r:
                resposta = {"autor": r["autor"], "conteudo": r["conteudo"]}
    payload = {
        "id": mid, "conversa_id": cid, "conteudo": conteudo,
        "autor": u["nome"], "usuario": u["usuario"], "cor": u["cor"],
        "autor_id": u["id"], "criado_em": quando, "editada": False,
        "responde_a": responde_a, "resposta": resposta,
    }
    emit("nova_dm", payload, room=f"dm_{cid}")
    # também avisa a sala pessoal do destinatário, para atualizar a lista de conversas mesmo sem estar com o chat aberto
    socketio.emit("dm_recebida_resumo", payload, room=f"usuario_{outro_id}")


@socketio.on("editar_dm")
def ws_editar_dm(data):
    if not logado():
        return
    u = usuario_atual()
    mid = data.get("id")
    novo = (data.get("conteudo") or "").strip()[:2000]
    if not novo:
        return
    with db.get_connection() as conn:
        m = conn.execute("SELECT * FROM mensagens_dm WHERE id=?", (mid,)).fetchone()
        if not m or m["autor_id"] != u["id"]:
            return
        conn.execute("UPDATE mensagens_dm SET conteudo=?, editada=1 WHERE id=?", (novo, mid))
        cid = m["conversa_id"]
    emit("dm_editada", {"id": mid, "conversa_id": cid, "conteudo": novo}, room=f"dm_{cid}")


@socketio.on("apagar_dm")
def ws_apagar_dm(data):
    if not logado():
        return
    u = usuario_atual()
    mid = data.get("id")
    with db.get_connection() as conn:
        m = conn.execute("SELECT * FROM mensagens_dm WHERE id=?", (mid,)).fetchone()
        if not m or m["autor_id"] != u["id"]:
            return
        cid = m["conversa_id"]
        conn.execute("DELETE FROM mensagens_dm WHERE id=?", (mid,))
    emit("dm_apagada", {"id": mid, "conversa_id": cid}, room=f"dm_{cid}")


# ---------------- Chamadas (voz/vídeo/tela) ----------------
# O servidor só faz três coisas aqui: guarda quem está em qual chamada,
# aplica o limite de 10 participantes, e retransmite as mensagens de
# sinalização (ofertas/respostas/candidatos WebRTC) entre os participantes.
# O áudio/vídeo em si nunca passa pelo servidor — vai direto entre os navegadores.

@socketio.on("chamada_iniciar")
def ws_chamada_iniciar(data):
    if not logado():
        return
    u = usuario_atual()
    para_id = data.get("para_id")
    tipo = data.get("tipo", "video")
    with db.get_connection() as conn:
        if not db.sao_amigos(conn, u["id"], para_id):
            emit("chamada_erro", {"erro": "Vocês precisam ser amigos para ligar."})
            return
    cid = f"c{u['id']}-{para_id}-{int(db.agora().replace('-', '').replace(':', '').replace(' ', ''))}"
    _chamadas[cid] = {"participantes": {u["id"]}, "tipo": tipo, "dono": u["id"]}
    join_room(f"chamada_{cid}")
    emit("chamada_criada", {"chamada_id": cid, "tipo": tipo})
    socketio.emit("chamada_recebida", {
        "chamada_id": cid, "tipo": tipo,
        "de": {"id": u["id"], "nome": u["nome"], "usuario": u["usuario"], "cor": u["cor"]},
        "participantes": list(_chamadas[cid]["participantes"]),
    }, room=f"usuario_{para_id}")


@socketio.on("chamada_convidar")
def ws_chamada_convidar(data):
    if not logado():
        return
    u = usuario_atual()
    cid = data.get("chamada_id")
    para_id = data.get("para_id")
    c = _chamadas.get(cid)
    if not c or u["id"] not in c["participantes"]:
        emit("chamada_erro", {"erro": "Você não está nessa chamada."})
        return
    if para_id in c["participantes"]:
        return
    if len(c["participantes"]) >= CHAMADA_MAX_PARTICIPANTES:
        emit("chamada_erro", {"erro": f"A chamada já está no limite de {CHAMADA_MAX_PARTICIPANTES} pessoas."})
        return
    with db.get_connection() as conn:
        if not db.sao_amigos(conn, u["id"], para_id):
            emit("chamada_erro", {"erro": "Você só pode adicionar amigos à chamada."})
            return
    socketio.emit("chamada_recebida", {
        "chamada_id": cid, "tipo": c["tipo"],
        "de": {"id": u["id"], "nome": u["nome"], "usuario": u["usuario"], "cor": u["cor"]},
        "participantes": list(c["participantes"]),
    }, room=f"usuario_{para_id}")


@socketio.on("chamada_aceitar")
def ws_chamada_aceitar(data):
    if not logado():
        return
    u = usuario_atual()
    cid = data.get("chamada_id")
    c = _chamadas.get(cid)
    if not c:
        emit("chamada_erro", {"erro": "Essa chamada já terminou."})
        return
    if len(c["participantes"]) >= CHAMADA_MAX_PARTICIPANTES:
        emit("chamada_erro", {"erro": f"A chamada já está no limite de {CHAMADA_MAX_PARTICIPANTES} pessoas."})
        return
    participantes_antes = list(c["participantes"])
    c["participantes"].add(u["id"])
    join_room(f"chamada_{cid}")
    # busca nome/cor de quem já estava na chamada, pra quem entra agora já ver os nomes certos
    with db.get_connection() as conn:
        if participantes_antes:
            marc = ",".join("?" * len(participantes_antes))
            linhas = conn.execute(
                f"SELECT id, nome_exibicao AS nome, usuario, cor FROM usuarios WHERE id IN ({marc})",
                participantes_antes,
            ).fetchall()
            info_antes = [dict(r) for r in linhas]
        else:
            info_antes = []
    # avisa quem já estava na chamada que uma nova pessoa entrou (pra criarem a conexão com ela)
    emit("chamada_participante_entrou", {
        "chamada_id": cid,
        "usuario": {"id": u["id"], "nome": u["nome"], "usuario": u["usuario"], "cor": u["cor"]},
    }, room=f"chamada_{cid}", include_self=False)
    # devolve pra quem acabou de entrar a lista de quem já estava lá (com nome/cor)
    emit("chamada_entrou", {"chamada_id": cid, "tipo": c["tipo"], "participantes": info_antes})


@socketio.on("chamada_recusar")
def ws_chamada_recusar(data):
    if not logado():
        return
    u = usuario_atual()
    cid = data.get("chamada_id")
    c = _chamadas.get(cid)
    if c:
        socketio.emit("chamada_recusada", {"chamada_id": cid, "usuario_id": u["id"]}, room=f"chamada_{cid}")


@socketio.on("chamada_sair")
def ws_chamada_sair(data):
    if not logado():
        return
    u = usuario_atual()
    cid = data.get("chamada_id")
    c = _chamadas.get(cid)
    if not c:
        return
    c["participantes"].discard(u["id"])
    leave_room(f"chamada_{cid}")
    emit("chamada_participante_saiu", {"chamada_id": cid, "usuario_id": u["id"]}, room=f"chamada_{cid}")
    if not c["participantes"]:
        del _chamadas[cid]


@socketio.on("webrtc_sinal")
def ws_webrtc_sinal(data):
    """Repassa oferta/resposta/candidato ICE de um participante para outro.
    O servidor não entende nem guarda o conteúdo — só entrega."""
    if not logado():
        return
    u = usuario_atual()
    cid = data.get("chamada_id")
    para_id = data.get("para_id")
    c = _chamadas.get(cid)
    if not c or u["id"] not in c["participantes"] or para_id not in c["participantes"]:
        return
    socketio.emit("webrtc_sinal", {
        "chamada_id": cid, "de_id": u["id"],
        "tipo": data.get("tipo"), "dados": data.get("dados"),
    }, room=f"usuario_{para_id}")


if __name__ == "__main__":
    db.init_db()
    db.seed_demo()
    porta = int(os.environ.get("PORT", 5000))
    em_producao = bool(os.environ.get("DATABASE_URL"))
    if em_producao:
        # Hospedagem (Render): sem debug, escutando em todas as interfaces
        socketio.run(app, host="0.0.0.0", port=porta, allow_unsafe_werkzeug=True)
    else:
        print("Nexus rodando em http://127.0.0.1:%d" % porta)
        socketio.run(app, host="0.0.0.0", port=porta, debug=True, allow_unsafe_werkzeug=True)
