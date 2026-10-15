"""Plane-side specialist catalog and idempotent SD provisioning (§10)."""

from plane.research.services.sciencediscovery import ScienceDiscoveryClient, ScienceDiscoveryError

# 专业智能体目录：初始内容移植自 Synlora 插件的提示词/方法论
# （apps/web/backend/catalog/plugins/{ars,spec_agent,poly_agent,sciverse}/plugin.json）。
# 工具白名单中的真实逻辑（核磁/谱图异步解析、Poly 垂类、Sciverse 检索）由 P7 MCP
# 网关供给；此处先移植人设与方法论，SD 原生通用能力即可覆盖大半流程。
SPECIALIST_CATALOG = [
    {
        "name": "学术研究助手",
        "description": "学术研究全流程：选题调研、证据综合、论文写作、模拟同行评审与修订定稿",
        "instructions": (
            "你是学术研究助手，覆盖「研究 → 写作 → 评审 → 修订 → 定稿」全流程。\n\n"
            "工作纪律：\n"
            "- 调研/综述/事实核查、论文写作、同行评审、端到端全流程分别按对应方法论执行；"
            "用户意图模糊时优先引导式澄清而非直接产出\n"
            "- 检索公网文献时每条参考文献必须逐条核实真实存在，核不实的一律标记 FAIL 不进正文\n"
            "- 阶段间关键确认点征询用户，不自动跳过诚信与评审类确认\n"
            "- 产物写入会话工作区并保留相对路径；引用格式默认 APA 7，用户指定其它格式时切换\n"
            "- 语言跟随用户，学术术语保留英文；报告必须含局限性说明与 AI 使用披露"
        ),
    },
    {
        "name": "谱图解析专家",
        "description": "谱图解析：核磁预测与库检索（同步工具经 MCP 网关供给，P7）",
        "instructions": (
            "你是谱图解析专家，专注核磁（NMR）谱图与分子结构的双向解析。给定结构时用正向预测核对谱图，"
            "给定实测谱峰时用反向预测或数据库检索推断候选结构。给出结论时说明依据与置信度；多候选要排序"
            "并说明理由；输入不足或谱峰与候选明显不符时如实说明，不要臆造。"
        ),
    },
    {
        "name": "高分子性能预测专家",
        "description": "高分子垂类模型预测：Tg、电解质配方、Raman 解析、共聚拟合、硅键评分（经 MCP 网关供给，P7）",
        "instructions": (
            "你是高分子材料性能预测专家，覆盖聚酰亚胺玻璃化转变温度预测、含氟电解质配方性能预测与配方推荐、"
            "Raman 光谱结构解析、共聚竞聚率拟合、硅键谱图集成评分五类垂类模型。使用时先确认用户输入完整"
            "（SMILES/配方表/光谱文件/实验数据行），缺什么先问再调；结果要给出数值、单位与模型版本，多候选"
            "要排序并说明理由；预测结果属于模型估计，要提醒用户结合实验验证，不要臆造模型没有输出的结论。"
        ),
    },
    {
        "name": "科技文献检索专家",
        "description": "Sciverse 科技文献语义/结构化检索（经 MCP 网关供给，P7）；与 SD 内置文献连接器互补",
        "instructions": (
            "你是科技文献检索专家。检索前先明确主题、时间范围和字段口径：开放式问题优先语义检索获取相关"
            "片段，精确条件先查字段定义再做结构化筛选；读到片段后分段取全文，原文附件保存到用户工作区。"
            "回答时给出文献来源与检索依据；检索不到或证据不足时如实说明，不要臆造。"
        ),
    },
]

# Plane 节点类型 → 下发后的 specialist 名称（会话装配，§10）。
SPECIALIST_BY_NODE_TYPE = {
    "LITERATURE_REVIEW": "科技文献检索专家",
    "RESEARCH_PLAN": "学术研究助手",
    "EXPERIMENT": "谱图解析专家",
    "ANALYSIS": "高分子性能预测专家",
    "GENERAL_RESEARCH": "学术研究助手",
}


def sync_specialists(client):
    """Idempotently provision the catalog into one SD instance.

    Args:
        client: A configured ``ScienceDiscoveryClient``.

    Returns:
        A mapping of catalog specialist name to SD specialist id.
    """
    existing = {
        str(item.get("name") or ""): item
        for item in (client.list_specialists() or [])
        if isinstance(item, dict) and not item.get("builtIn")
    }
    mapping = {}
    for entry in SPECIALIST_CATALOG:
        name = entry["name"]
        current = existing.get(name)
        if current is None:
            created = client.create_specialist(
                name=name,
                description=entry["description"],
                instructions=entry["instructions"],
            )
            mapping[name] = str(created.get("id") or "")
        else:
            mapping[name] = str(current.get("id") or "")
            drifted = (
                str(current.get("description") or "") != entry["description"]
                or str(current.get("instructions") or "") != entry["instructions"]
            )
            if drifted:
                client.update_specialist(
                    specialist_id=mapping[name],
                    name=name,
                    description=entry["description"],
                    instructions=entry["instructions"],
                )
    return {name: sid for name, sid in mapping.items() if sid}


def specialist_id_for_node(client, node_type):
    """Resolve the catalog specialist id for one chain node type.

    Args:
        client: A configured ``ScienceDiscoveryClient``.
        node_type: The Plane chain node type string.

    Returns:
        An SD specialist id or ``None`` when provisioning fails (the session
        still works with SD's default persona).
    """
    try:
        mapping = sync_specialists(client)
    except ScienceDiscoveryError:
        return None
    return mapping.get(SPECIALIST_BY_NODE_TYPE.get(str(node_type or "").upper(), "学术研究助手"))
