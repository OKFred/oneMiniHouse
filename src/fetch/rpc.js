let rpc = [
    {
        request: {
            header: {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            },
            url: 'https://fred.wiki:99/query/user',
            data: {},
        },
        response: {
            data: {},
        },
        info: {
            for: '用户登录',
            type: 'wiki',
        },
    },
    {
        request: {
            header: {
                method: 'GET',
            },
            url: 'https://fred.wiki:99/query/user',
            data: {},
        },
        response: {
            data: {},
        },
        info: {
            for: '用户登出',
            type: 'wiki',
        },
    },
    {
        request: {
            header: {
                method: 'GET',
            },
            url: 'https://fred.wiki:99/query/status',
            data: {},
        },
        response: {
            data: {},
        },
        info: {
            for: '用户登录状态',
            type: 'wiki',
        },
    },
    {
        request: {
            header: {
                method: 'GET',
            },
            url: 'https://fred.wiki:99/query/house',
            data: {},
        },
        response: {
            data: {},
        },
        info: {
            for: '二手房数据查询',
            type: 'wiki',
        },
    },
    {
        request: {
            header: {
                method: 'GET',
            },
            url: 'https://fred.wiki:99/query/houseBasic',
            data: {},
        },
        response: {
            data: {},
        },
        info: {
            for: '二手房基础信息查询',
            type: 'wiki',
        },
    },
    {
        request: {
            header: {
                method: 'GET',
            },
            url: 'https://fred.wiki:99/query/trend',
            data: {},
        },
        response: {
            data: {},
        },
        info: {
            for: '摆渡热搜查询',
            type: 'wiki',
        },
    },
    {
        request: {
            header: {
                method: 'GET',
            },
            url: 'https://fred.wiki:99/query/weibo',
            data: {},
        },
        response: {
            data: {},
        },
        info: {
            for: '微薄热搜查询',
            type: 'wiki',
        },
    },
    {
        request: {
            header: {
                method: 'GET',
            },
            url: 'https://fred.wiki:99/query/sensor',
            data: {},
        },
        response: {
            data: {},
        },
        info: {
            for: '室内传感器数据查询',
            type: 'wiki',
        },
    },
    {
        request: {
            header: {
                method: 'GET',
            },
            url: 'https://fred.wiki:99/query/electricity_meter',
            data: {},
        },
        response: {
            data: {},
        },
        info: {
            for: '室内电表数据查询',
            type: 'wiki',
        },
    },
]

export default rpc
