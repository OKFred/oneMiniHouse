import router from "../src/router/index.js"; //自定义路由

function pageFinder() {
    let pages = router
        .filter((obj) => !obj.root)
        .map((obj) => {
            return { path: obj.url.replace(/^\//, "") };
        }); //主包页面
    let subPackages = [];
    for (let obj of router) {
        if (!obj.root || subPackages.find((str) => str === obj.root)) continue;
        subPackages.push(obj.root);
    } //先拿到分包的数量
    let subpagesFinder = (rootReg) =>
        router
            .filter((obj) => {
                let condition = rootReg.test(obj.url);
                if (condition) obj.url = obj.url.replace(rootReg, "");
                return condition;
            })
            .map((obj) => {
                return { path: obj.url };
            });
    subPackages = subPackages.map((root) => {
        let roots = root.split("/");
        let rootReg = new RegExp(`\^\/${roots.join(`\/`)}\/`, "gi");
        let pages = subpagesFinder(rootReg);
        return {
            root,
            pages,
        };
    });
    return {
        pages,
        subPackages,
    };
} //在路由表里找到所有匹配的页面

function uniPageMaker(pageObj) {
    return {
        ...pageObj,
        easycom: {
            custom: {
                "^u-(.*)": "uview-plus/components/u-$1/u-$1.vue",
            },
        },
        globalStyle: {
            navigationStyle: "custom",
            usingComponents: {
                "ec-canvas": "/wxcomponents/ec-canvas/ec-canvas",
            },
        },
        tabBar: {
            color: "#ACACAC",
            selectedColor: "#181818",
            iconWidth: "24px",
            fontSize: "15px",
            list: [
                {
                    pagePath: "pages/index/index",
                    iconPath: "static/tabbar/home_unselected.png",
                    selectedIconPath: "static/tabbar/home_selected.png",
                    text: "首页",
                },
                {
                    pagePath: "pages/mine/index",
                    iconPath: "static/tabbar/me_unselected.png",
                    selectedIconPath: "static/tabbar/me_selected.png",
                    text: "我的",
                },
            ],
        },
        permission: {
            "scope.userLocation": {
                desc: "位置用于用户主动选择所在位置",
            },
        },
    };
}

export { pageFinder, uniPageMaker };
