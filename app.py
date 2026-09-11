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
    """Retorna o canal se o usuário for membro do servidor dele; senão None."""
    row = conn.execute(
        """SELECT c.* FROM canais c
           JOIN membros m ON m.servidor_id = c.servidor_id
           WHERE c.id=? AND m.usuario_id=?""",
        (canal_id, usuario_id),
    ).fetchone()
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
        canais = conn.execute(
            "SELECT * FROM canais WHERE servidor_id=? ORDER BY ordem, id", (sid,)
        ).fetchall()
        membros = conn.execute(
            """SELECT u.id, u.nome_exibicao AS nome, u.usuario, u.cor, m.papel
               FROM membros m JOIN usuarios u ON u.id = m.usuario_id
               WHERE m.servidor_id=? ORDER BY
                 CASE m.papel WHEN 'dono' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.nome_exibicao""",
            (sid,),
        ).fetchall()
    # organiza canais por categoria
    cats_out = []
    for c in cats:
        cats_out.append({
            "id": c["id"], "nome": c["nome"],
            "canais": [dict(k) for k in canais if k["categoria_id"] == c["id"]],
        })
    sem_cat = [dict(k) for k in canais if k["categoria_id"] is None]
    return jsonify({
        "id": srv["id"], "nome": srv["nome"], "convite": srv["convite"],
        "dono_id": srv["dono_id"],
        "categorias": cats_out, "sem_categoria": sem_cat,
        "membros": [dict(m) for m in membros],
    })


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
        m = conn.execute("SELECT papel FROM membros WHERE servidor_id=? AND usuario_id=?", (sid, uid)).fetchone()
        if not m or m["papel"] not in ("dono", "admin"):
            return jsonify({"erro": "Só o dono ou admin pode criar canais."}), 403
        cid = db.inserir(conn,
            "INSERT INTO canais (servidor_id, categoria_id, nome, ordem, criado_em) VALUES (?,?,?,?,?)",
            (sid, categoria_id, nome, 99, db.agora()),
        )
    return jsonify({"id": cid, "nome": nome, "categoria_id": categoria_id})


# ==================== API: MENSAGENS ====================

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
        # autor apaga a própria; dono/admin do servidor também podem
        pode = (m["autor_id"] == u["id"])
        if not pode:
            papel = conn.execute(
                """SELECT mm.papel FROM membros mm
                   JOIN canais c ON c.servidor_id = mm.servidor_id
                   WHERE c.id=? AND mm.usuario_id=?""", (m["canal_id"], u["id"])).fetchone()
            pode = papel and papel["papel"] in ("dono", "admin")
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
