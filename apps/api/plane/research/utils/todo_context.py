"""待办聚合期间复用只读权限查询，请求结束后释放结果。"""

from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps

_TODO_QUERY_CACHE = ContextVar("todo_query_cache", default=None)


@contextmanager
def todo_query_context():
    """为一次只读待办聚合建立独立上下文，嵌套调用复用同一份结果。"""
    if _TODO_QUERY_CACHE.get() is not None:
        yield
        return
    token = _TODO_QUERY_CACHE.set({})
    try:
        yield
    finally:
        _TODO_QUERY_CACHE.reset(token)


def reuse_todo_query(function):
    """仅在待办上下文中复用相同参数的只读查询。

    Args:
        function: 参数为模型、标量或日期的只读查询函数。

    Returns:
        保留原函数签名与说明的包装函数。
    """

    def identity(value):
        """以模型类型和主键识别同一请求中重复加载的对象。"""
        return (value._meta.label_lower, value.pk) if hasattr(value, "_meta") else value

    @wraps(function)
    def wrapped(*args, **kwargs):
        """从当前待办上下文读取结果，其他调用保持原有行为。"""
        query_cache = _TODO_QUERY_CACHE.get()
        if query_cache is None:
            return function(*args, **kwargs)
        key = (
            function,
            tuple(identity(value) for value in args),
            tuple(sorted((name, identity(value)) for name, value in kwargs.items())),
        )
        if key not in query_cache:
            query_cache[key] = function(*args, **kwargs)
        return query_cache[key]

    return wrapped
