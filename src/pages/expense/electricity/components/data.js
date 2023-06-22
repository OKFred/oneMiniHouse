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
                    { id: 58, name: "房东2F" },
                    { id: 65, name: "小忠1F" },
                ],
            },
        ];
    }
}

export { fetchData, fakeData };
