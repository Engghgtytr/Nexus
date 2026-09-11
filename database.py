"""
database.py — camada de dados do Nexus

Funciona com dois bancos, escolhido automaticamente:
  - PostgreSQL  quando existe a variável de ambiente DATABASE_URL (hospedagem)
  - SQLite      caso contrário (desenvolvimento no seu PC)

Assim você continua testando local com SQLite, e em produção (Render) o
mesmo código usa Postgres, onde os dados não se perdem entre reinícios.

O restante do app escreve SQL com placeholders "?" e usa uma coluna "id"
retornada pelo helper inserir(). A camada abaixo cuida das diferenças de
dialeto entre os dois bancos.
"""

import os
import re
import secrets
from contextlib import contextmanager
from pathlib import Path
from datetime import datetime
from werkzeug.security import generate_password_hash

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
USANDO_PG = bool(DATABASE_URL)

DB_PATH = Path(__file__).parent / "nexus.db"

if USANDO_PG:
    import psycopg
    from psycopg.rows import dict_row
    # Render às vezes entrega a URL como "postgres://"; psycopg quer "postgresql://"
    if DATABASE_URL.startswith("postgres://"):
        DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)
else:
    import sqlite3


# ---------------------------------------------------------------
# Adaptação de conexão: uma interface comum para os dois bancos
# ---------------------------------------------------------------

class ConexaoPG:
    """Envolve psycopg para aceitar SQL com '?' e devolver linhas tipo dict."""

    def __init__(self, conn):
        self._c = conn

    def execute(self, sql, params=()):
        sql = sql.replace("?", "%s")
        cur = self._c.cursor(row_factory=dict_row)
        cur.execute(sql, params)
        return CursorPG(cur)

    def commit(self):
        self._c.commit()

    def close(self):
        self._c.close()


class CursorPG:
    def __init__(self, cur):
        self._cur = cur

    def fetchone(self):
        return self._cur.fetchone()

    def fetchall(self):
        return self._cur.fetchall()

    @property
    def lastrowid(self):
        # usado após INSERT ... RETURNING id
        try:
            row = self._cur.fetchone()
            if row:
                return list(row.values())[0]
        except Exception:
            pass
        return None


@contextmanager
def get_connection():
    if USANDO_PG:
        raw = psycopg.connect(DATABASE_URL, autocommit=False)
        conn = ConexaoPG(raw)
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()
    else:
        conn = sqlite3.connect(DB_PATH, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA busy_timeout = 5000")
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()


def inserir(conn, sql, params=()):
    """
    Executa um INSERT e retorna o id gerado, funcionando nos dois bancos.
    Espera um INSERT comum (sem RETURNING); a função adiciona o que precisar.
    """
    if USANDO_PG:
        cur = conn.execute(sql + " RETURNING id", params)
        return cur.fetchone()["id"]
    else:
        cur = conn.execute(sql, params)
        return cur.lastrowid


def agora():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def gerar_codigo(n=8):
    alfabeto = "abcdefghijkmnpqrstuvwxyz23456789"
    return "".join(secrets.choice(alfabeto) for _ in range(n))


# ---------------------------------------------------------------
# Esquema — definido de forma neutra e adaptado para cada banco
# ---------------------------------------------------------------

def _schema():
    if USANDO_PG:
        pk = "SERIAL PRIMARY KEY"
    else:
        pk = "INTEGER PRIMARY KEY AUTOINCREMENT"
    return f"""
        CREATE TABLE IF NOT EXISTS usuarios (
            id {pk},
            usuario TEXT NOT NULL UNIQUE,
            nome_exibicao TEXT NOT NULL,
            senha_hash TEXT NOT NULL,
            cor TEXT NOT NULL DEFAULT '#a855f7',
            bio TEXT DEFAULT '',
            criado_em TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS servidores (
            id {pk},
            nome TEXT NOT NULL,
            dono_id INTEGER NOT NULL REFERENCES usuarios(id),
            convite TEXT NOT NULL UNIQUE,
            criado_em TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS membros (
            id {pk},
            servidor_id INTEGER NOT NULL REFERENCES servidores(id) ON DELETE CASCADE,
            usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
            papel TEXT NOT NULL DEFAULT 'membro',
            entrou_em TEXT NOT NULL,
            UNIQUE (servidor_id, usuario_id)
        );
        CREATE TABLE IF NOT EXISTS categorias (
            id {pk},
            servidor_id INTEGER NOT NULL REFERENCES servidores(id) ON DELETE CASCADE,
            nome TEXT NOT NULL,
            ordem INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS canais (
            id {pk},
            servidor_id INTEGER NOT NULL REFERENCES servidores(id) ON DELETE CASCADE,
            categoria_id INTEGER REFERENCES categorias(id) ON DELETE SET NULL,
            nome TEXT NOT NULL,
            descricao TEXT DEFAULT '',
            ordem INTEGER NOT NULL DEFAULT 0,
            criado_em TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mensagens (
            id {pk},
            canal_id INTEGER NOT NULL REFERENCES canais(id) ON DELETE CASCADE,
            autor_id INTEGER NOT NULL REFERENCES usuarios(id),
            conteudo TEXT NOT NULL,
            responde_a INTEGER REFERENCES mensagens(id) ON DELETE SET NULL,
            editada INTEGER NOT NULL DEFAULT 0,
            criado_em TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS reacoes (
            id {pk},
            mensagem_id INTEGER NOT NULL REFERENCES mensagens(id) ON DELETE CASCADE,
            usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
            emoji TEXT NOT NULL,
            UNIQUE (mensagem_id, usuario_id, emoji)
        );
        CREATE TABLE IF NOT EXISTS amizades (
            id {pk},
            solicitante_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
            destinatario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'pendente',
            criado_em TEXT NOT NULL,
            respondido_em TEXT,
            UNIQUE (solicitante_id, destinatario_id)
        );
        CREATE TABLE IF NOT EXISTS bloqueios (
            id {pk},
            usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
            bloqueado_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
            criado_em TEXT NOT NULL,
            UNIQUE (usuario_id, bloqueado_id)
        );
        CREATE TABLE IF NOT EXISTS conversas_dm (
            id {pk},
            usuario_a_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
            usuario_b_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
            criado_em TEXT NOT NULL,
            UNIQUE (usuario_a_id, usuario_b_id)
        );
        CREATE TABLE IF NOT EXISTS mensagens_dm (
            id {pk},
            conversa_id INTEGER NOT NULL REFERENCES conversas_dm(id) ON DELETE CASCADE,
            autor_id INTEGER NOT NULL REFERENCES usuarios(id),
            conteudo TEXT NOT NULL,
            responde_a INTEGER REFERENCES mensagens_dm(id) ON DELETE SET NULL,
            editada INTEGER NOT NULL DEFAULT 0,
            lida INTEGER NOT NULL DEFAULT 0,
            criado_em TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_amizades_sol ON amizades(solicitante_id);
        CREATE INDEX IF NOT EXISTS idx_amizades_dest ON amizades(destinatario_id);
        CREATE INDEX IF NOT EXISTS idx_bloqueios_user ON bloqueios(usuario_id);
        CREATE INDEX IF NOT EXISTS idx_dm_conversa ON mensagens_dm(conversa_id);
        CREATE INDEX IF NOT EXISTS idx_membros_srv ON membros(servidor_id);
        CREATE INDEX IF NOT EXISTS idx_membros_user ON membros(usuario_id);
        CREATE INDEX IF NOT EXISTS idx_canais_srv ON canais(servidor_id);
        CREATE INDEX IF NOT EXISTS idx_msg_canal ON mensagens(canal_id);
        CREATE INDEX IF NOT EXISTS idx_reacoes_msg ON reacoes(mensagem_id);
    """


def init_db():
    schema = _schema()
    with get_connection() as conn:
        if USANDO_PG:
            # psycopg executa um comando por vez
            for cmd in [c.strip() for c in schema.split(";") if c.strip()]:
                conn.execute(cmd)
        else:
            conn.executescript(schema)


MOLDES = {
    "padrao": [
        ("Informações", ["anúncios", "regras"]),
        ("Comunidade", ["geral", "memes", "mídia"]),
    ],
    "jogos": [
        ("Informações", ["anúncios", "regras"]),
        ("Geral", ["bate-papo", "procura-se-time", "clipes"]),
        ("Jogos", ["valorant", "minecraft", "gta"]),
    ],
    "amigos": [
        ("Geral", ["geral", "figurinhas", "fotos"]),
        ("Rolês", ["planos", "playlist"]),
    ],
    "estudos": [
        ("Informações", ["avisos", "cronograma"]),
        ("Matérias", ["matemática", "português", "ciências", "dúvidas"]),
        ("Apoio", ["materiais", "trabalhos-em-grupo"]),
    ],
    "escolar": [
        ("Informações", ["mural", "calendário"]),
        ("Turmas", ["geral", "eventos", "grêmio"]),
        ("Ajuda", ["secretaria", "dúvidas"]),
    ],
}


def criar_servidor_completo(conn, nome, dono_id, molde="padrao"):
    convite = gerar_codigo()
    sid = inserir(
        conn,
        "INSERT INTO servidores (nome, dono_id, convite, criado_em) VALUES (?,?,?,?)",
        (nome, dono_id, convite, agora()),
    )
    conn.execute(
        "INSERT INTO membros (servidor_id, usuario_id, papel, entrou_em) VALUES (?,?,?,?)",
        (sid, dono_id, "dono", agora()),
    )
    estrutura = MOLDES.get(molde, MOLDES["padrao"])
    for i, (cat_nome, canais) in enumerate(estrutura):
        cat_id = inserir(
            conn,
            "INSERT INTO categorias (servidor_id, nome, ordem) VALUES (?,?,?)",
            (sid, cat_nome, i),
        )
        for j, canal in enumerate(canais):
            conn.execute(
                "INSERT INTO canais (servidor_id, categoria_id, nome, ordem, criado_em) VALUES (?,?,?,?,?)",
                (sid, cat_id, canal, j, agora()),
            )
    return sid


def seed_demo():
    with get_connection() as conn:
        if conn.execute("SELECT 1 FROM usuarios LIMIT 1").fetchone():
            return
        uid = inserir(
            conn,
            "INSERT INTO usuarios (usuario, nome_exibicao, senha_hash, cor, criado_em) VALUES (?,?,?,?,?)",
            ("demo", "Demonstração", generate_password_hash("demo1234"), "#a855f7", agora()),
        )
        sid = criar_servidor_completo(conn, "Comunidade Nexus", uid)
        canal = conn.execute(
            "SELECT id FROM canais WHERE servidor_id=? AND nome='geral'", (sid,)
        ).fetchone()
        if canal:
            cid = canal["id"]
            conn.execute(
                "INSERT INTO mensagens (canal_id, autor_id, conteudo, criado_em) VALUES (?,?,?,?)",
                (cid, uid, "Bem-vindo ao Nexus! Este é o canal geral. Mande a primeira mensagem.", agora()),
            )


def obter_ou_criar_conversa(conn, uid_a, uid_b):
    """Retorna o id da conversa DM entre dois usuários, criando se não existir.
    Guarda sempre com o menor id primeiro, para a UNIQUE funcionar nos dois sentidos."""
    a, b = (uid_a, uid_b) if uid_a < uid_b else (uid_b, uid_a)
    row = conn.execute(
        "SELECT id FROM conversas_dm WHERE usuario_a_id=? AND usuario_b_id=?", (a, b)
    ).fetchone()
    if row:
        return row["id"]
    return inserir(
        conn,
        "INSERT INTO conversas_dm (usuario_a_id, usuario_b_id, criado_em) VALUES (?,?,?)",
        (a, b, agora()),
    )


def sao_amigos(conn, uid_a, uid_b):
    row = conn.execute(
        """SELECT 1 FROM amizades WHERE status='aceita' AND
           ((solicitante_id=? AND destinatario_id=?) OR (solicitante_id=? AND destinatario_id=?))""",
        (uid_a, uid_b, uid_b, uid_a),
    ).fetchone()
    return row is not None


def existe_bloqueio(conn, uid_a, uid_b):
    row = conn.execute(
        "SELECT 1 FROM bloqueios WHERE (usuario_id=? AND bloqueado_id=?) OR (usuario_id=? AND bloqueado_id=?)",
        (uid_a, uid_b, uid_b, uid_a),
    ).fetchone()
    return row is not None


if __name__ == "__main__":
    init_db()
    seed_demo()
    print("Banco do Nexus inicializado. Usando:", "PostgreSQL" if USANDO_PG else "SQLite")
