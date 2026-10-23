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
    "Graphics": r"computer graphics|rendering|ray tracing|cs ?184|6\.837|opengl|geometry processing|\bsiggraph\b|\bshaders?\b",
    "Math for CS": r"discrete math|mathematics for computer science|6\.042|6\.1200|linear algebra|18\.06|probability|statistics|calculus|optimization|information theory|convex",
    "Quantum Computing": r"quantum comput|quantum information|qubit",
    "Robotics": r"robotic|\brobot\b|control theory|autonomous",
    "HCI": r"human.computer interaction|\bhci\b|user interface design|ux design",
    "Parallel & HPC": r"parallel (computing|programming)|\bgpu\b|cuda|high performance computing|\bhpc\b|concurren",
    # --- physics (specific topics first; General Physics is the catch-all) ---
    "Classical Mechanics": r"classical mechanics|\b8\.01[a-z]?\b|newtonian mechanic|lagrangian|hamiltonian mechanic|analytical mechanics|rigid body dynamics",
    "Electromagnetism": r"electromagneti|\b8\.02[a-z]?\b|electricity and magnetism|electrodynamics|maxwell|electrostatic|magnetis",
    "Quantum Physics": r"quantum (mechanic|physic|field theor|electrodynamic|optic)|\b8\.0[456][a-z]?\b|schr(ö|o)dinger|wave function|\bqft\b|feynman",
    "Thermo & Statistical Mechanics": r"thermodynamic|statistical (mechanic|physic)|\b8\.044\b|kinetic theory|heat engine|carnot",
    "Relativity & Gravitation": r"\brelativity\b|gravitation|\b8\.033\b|\b8\.962\b|black hole|spacetime|event horizon",
    "Astrophysics & Cosmology": r"astrophysic|cosmolog|astronom|stellar|galax|exoplanet|dark (matter|energy)|supernova",
    "Particle & Nuclear Physics": r"particle physics|nuclear physics|standard model|\bquark|higgs|collider|\bqcd\b|plasma physics",
    "Condensed Matter": r"condensed matter|solid.state physics|superconduct|semiconductor physics|many.body physics",
    "Optics & Waves": r"\boptics\b|photonic|vibrations and waves|\b8\.03[a-z]?\b|laser physics|acoustics|interference|diffraction",
    "General Physics": r"\bphysics\b",
    # --- wisdom & life ("philosophy" in the broad sense: anyone's hard-won understanding) ---
    "Philosophy": r"philosoph|stoic|existentialis|\bethics\b|socrates|\bplato\b|aristotle|nietzsche|\bkant\b|"
                  r"metaphysic|epistemolog|\bwisdom\b|phil ?\d{2,3}\b",
    "Psychology & the Mind": r"psycholog|cognitive (science|bias)|behaviou?ral (science|econom)|mindfulness|"
                             r"meditation|\bhabits\b|willpower|neuroscience|happiness",
    "Life Advice & Experience": r"life advice|life lessons?|commencement|graduation speech|"
                                r"advice (to|for) (my younger self|young)|how to live|last lecture|"
                                r"rules for life|lessons i('ve)? learned|regrets of",
    "Health & Longevity": r"longevity|\bsleep\b|nutrition|\bdiet\b|exercise science|healthspan|\baging\b|wellbeing|well.being|mental health|public health|\bmedicine\b",
    "Money & Career": r"personal finance|financial literacy|investing|\bcareers?\b|negotiation|"
                            r"productivity|time management|entrepreneurship|leadership",
    "History & Civilization": r"history of|world history|civili[sz]ation|ancient (rome|greece|egypt|history)|"
                              r"archaeolog|anthropolog|\bempires?\b|world war|\bmedieval\b|renaissance|cold war",
    "Economics & Society": r"\beconom|sociolog|geopolitic|political (science|philosophy|econom)|democracy|inequality",
    "Communication & Relationships": r"public speaking|rhetoric|communication skills?|how to (talk|speak)|storytelling|"
                                     r"relationships?\b|body language|charisma|persuasion|\bconversations?\b",
    "Rationality & Decision-Making": r"decision.making|critical thinking|rationality|cognitive bias|mental models?|"
                                     r"first principles|clear(er)? thinking|problem.solving|bayesian (reasoning|thinking)|fallac",
    "Meaning & Religion": r"meaning of life|religion|theolog|spiritual|buddhis|consciousness|mortality|good life|"
                          r"mythology|\bzen\b|\bfaith\b",
}
assert not any("," in t for t in TOPICS), "topic names are stored comma-joined and must not contain commas"
_COMPILED = {k: re.compile(v, re.I) for k, v in TOPICS.items()}

PHYSICS_TOPICS = {
    "Classical Mechanics", "Electromagnetism", "Quantum Physics", "Thermo & Statistical Mechanics",
    "Relativity & Gravitation", "Astrophysics & Cosmology", "Particle & Nuclear Physics",
    "Condensed Matter", "Optics & Waves", "General Physics",
}
WISDOM_TOPICS = {
    "Philosophy", "Psychology & the Mind", "Life Advice & Experience", "Health & Longevity",
    "Money & Career", "History & Civilization", "Economics & Society",
    "Communication & Relationships", "Rationality & Decision-Making", "Meaning & Religion",
}
# topic -> field; the "Other" fallback belongs to no field and shows under every field filter
FIELD_OF = {t: ("physics" if t in PHYSICS_TOPICS else "wisdom" if t in WISDOM_TOPICS else "cs") for t in TOPICS}
FIELDS = {"cs": "Computer Science", "physics": "Physics", "wisdom": "Wisdom & Life"}

_LECTURE = re.compile(
    r"\blecture\b|\blec\b|\bcourse\b|\bclass\b|\bseminar\b|\btutorial\b|\bsession\b|"
    r"\bcs ?\d{2,3}[a-z]?\b|\b\d{1,2}\.\d{2,3}\b|\b\d{2}-\d{3}\b|\bmit\b|opencourseware|semester|"
    r"\b(fall|spring|winter|summer) \d{4}\b|vorlesung|\bunit \d+|\bweek \d+|\bpart \d+|"
    r"\btalks?\b|\bspeech\b|commencement|keynote|\binterview\b|masterclass|\badvice\b|fireside",
    re.I,
)


def classify(text: str, max_topics: int = 3) -> list[str]:
    hits = [k for k, rx in _COMPILED.items() if rx.search(text or "")]
    return hits[:max_topics] or ["Other"]


def looks_like_lecture(title: str, desc: str = "") -> bool:
    return bool(_LECTURE.search(f"{title} {desc[:300]}"))
