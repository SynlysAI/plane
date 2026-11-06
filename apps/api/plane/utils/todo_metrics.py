"""低开销统计待办请求及来源跨数据库连接执行的 SQL 数量。"""

from contextlib import ExitStack, contextmanager

from django.db import connections


@contextmanager
def count_todo_queries():
    """统计当前线程各数据库别名上的 SQL，不保留语句或参数。

    Yields:
        包含 query_count 的计数字典。
    """
    counter = {"query_count": 0}

    def count_query(execute, sql, params, many, context):
        """累计执行次数并调用原数据库执行函数。

        Args:
            execute: Django 提供的后续执行函数。
            sql: 待执行语句，仅传递而不存储。
            params: 语句参数，仅传递而不存储。
            many: 是否批量执行。
            context: 数据库执行上下文。

        Returns:
            原数据库执行函数的结果。
        """
        counter["query_count"] += 1
        return execute(sql, params, many, context)

    with ExitStack() as stack:
        for connection in connections.all():
            stack.enter_context(connection.execute_wrapper(count_query))
        yield counter
