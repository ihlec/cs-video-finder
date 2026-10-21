"""Keyword-based topic tagging and lecture detection."""
from __future__ import annotations

import re

TOPICS = {
    "Intro & Programming": r"\bcs ?50\b|\bcs ?61a\b|intro(duction)? to (computer science|programming|cs)|programming (in|with) (python|java|c\b)|\bpython\b|\bjava\b|structure and interpretation|\bsicp\b|6\.0001|6\.100",
    "Algorithms & Data Structures": r"algorithm|data structure|\bdsa\b|6\.006|6\.046|graph theory|dynamic programming|sorting",
    "Theory of Computation": r"theory of computation|automata|computability|complexity theory|turing machine|\bp vs\.? np\b|formal language|6\.045|6\.840",
    "Machine Learning": r"machine learning|\bml\b|cs ?229|statistical learning|6\.036|6\.867|learning theory",
    "Deep Learning": r"deep learning|neural net|transformer|\bllm|cs ?231n|cs ?224n|6\.s191|backprop|diffusion model|large language model",
    "Artificial Intelligence": r"artificial intelligence|\bai\b|cs ?188|6\.034|search and planning|knowledge representation",
    "NLP": r"natural language|\bnlp\b|cs ?224n|speech recognition|language model",
    "Computer Vision": r"computer vision|image processing|cs ?231n|visual recognition",
    "Reinforcement Learning": r"reinforcement learning|\brl\b|markov decision|cs ?285|cs ?234",
    "Operating Systems": r"operating system|\bos\b|6\.828|6\.s081|6\.1810|kernel|cs ?162|virtual memory|xv6",
    "Systems & Architecture": r"computer architecture|computer organization|computer systems|cs ?61c|15-213|csapp|cpu design|risc-v|digital design|6\.004|verilog",
    "Distributed Systems": r"distributed system|6\.824|6\.5840|consensus|raft|paxos|cloud computing|mapreduce",
    "Decentralized Web": r"\bipfs\b|interplanetary file system|decentrali[sz]|peer.to.peer|\bp2p\b|"
                         r"distributed hash table|\bdht\b|blockchain|\bweb ?3\b|bittorrent|content.address|"
                         r"smart contract|ethereum|\bbitcoin\b|cryptocurrenc|libp2p|filecoin|15\.s12|"
                         r"activitypub|fediverse|federated (social|network|protocol)|self.sovereign identit|"
                         r"merkle (tree|dag|proof)|hypercore|\bdat protocol\b|gossip protocol|\bnostr\b",
    "Databases": r"database|\bsql\b|15-445|15-721|cs ?186|query processing|transaction",
    "Networks": r"computer network|networking|tcp/ip|\btcp\b|internet protocol|cs ?168|routing",
    "Security & Cryptography": r"security|cryptograph|6\.858|6\.857|cs ?161|cs ?255|exploit|privacy",
    "Programming Languages & Compilers": r"compiler|programming language|type system|lambda calculus|functional programming|haskell|ocaml|cs ?143|15-411|interpreter|semantics",
    "Software Engineering": r"software engineering|software construction|6\.031|6\.005|design pattern|testing|agile|software design",
    "Graphics": r"computer graphics|rendering|ray tracing|cs ?184|6\.837|opengl|geometry processing",
    "Math for CS": r"discrete math|mathematics for computer science|6\.042|6\.1200|linear algebra|18\.06|probability|statistics|calculus|optimization|information theory|convex",
    "Quantum Computing": r"quantum comput|quantum information|qubit",
    "Robotics": r"robotic|\brobot\b|control theory|autonomous",
    "HCI": r"human.computer interaction|\bhci\b|user interface design|ux design",
    "Parallel & HPC": r"parallel (computing|programming)|\bgpu\b|cuda|high performance computing|\bhpc\b|concurren",
}
_COMPILED = {k: re.compile(v, re.I) for k, v in TOPICS.items()}

_LECTURE = re.compile(
    r"\blecture\b|\blec\b|\bcourse\b|\bclass\b|\bseminar\b|\btutorial\b|\bsession\b|"
    r"\bcs ?\d{2,3}[a-z]?\b|\b\d{1,2}\.\d{3}\b|\b\d{2}-\d{3}\b|\bmit\b|opencourseware|semester|"
    r"\b(fall|spring|winter|summer) \d{4}\b|vorlesung|\bunit \d+|\bweek \d+|\bpart \d+",
    re.I,
)


def classify(text: str, max_topics: int = 3) -> list[str]:
    hits = [k for k, rx in _COMPILED.items() if rx.search(text or "")]
    return hits[:max_topics] or ["Other CS"]


def looks_like_lecture(title: str, desc: str = "") -> bool:
    return bool(_LECTURE.search(f"{title} {desc[:300]}"))
