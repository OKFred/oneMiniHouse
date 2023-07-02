async function fetchData({ options, lists, deletes } = {}) {
    if (options) {
        let queryObj = await publicAPI.allOptionQuery(options);
        let { status, result } = queryObj.response;
        if (!status) return globalThis.queryResult(status, result.message);
        return result.data;
    }
    if (lists) {
        let queryObj = await enterpriseAPI.listQuery(lists);
        let { status, result } = queryObj.response;
        if (!status) return globalThis.queryResult(status, result.message);
        return result.data;
    }
    if (deletes) {
        let queryObj = await enterpriseAPI.deleteQuery(deletes);
        let { status, result } = queryObj.response;
        if (!status) return globalThis.queryResult(status, result.message);
        return true;
    }
}

async function fakeData({ options } = {}) {
    await globalThis.sleep(300);
    if (options) {
        return [
            {
                tag: "users",
                list: [
                    { id: "0E", name: "办公室3F" },
                    { id: "01", name: "默认" },
                ],
            },
        ];
    }
}

export { fetchData, fakeData };
