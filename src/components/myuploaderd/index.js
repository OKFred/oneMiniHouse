Component({
    options: {
        // 这个配置决定是否由 `app.wxss` 和页面 `wxss` 中的样式定义来决定
        addGlobalClass: true,
        multipleSlots: true, // 在组件定义时的选项中启用多 slot 支持
    },
    properties: {
        imageArr: {
            type: Array,
        },
        parent: {
            type: String,
        },
        defaultImage: {
            type: String,
            value: "/assets/img_addp.png",
        },
        readOnly: {
            type: Boolean,
        },
        maxCount: {
            type: Number,
            value: 9,
        }, //默认9张图
        maxSize: {
            type: Number,
            value: 10485760,
        }, //默认10M
    },
    data: {},
    ready: function () {},
    methods: {
        async onPictureSelection(e) {
            console.log("上传图片");
            let { parent } = e.currentTarget.dataset;
            try {
                let { imageArr, maxSize, maxCount } = this.data;
                let { tempFiles } = await wx.p.chooseImage();
                console.log("选择了以下图片", tempFiles);
                for (let i = 0; i < tempFiles.length; i++) {
                    let { path, size } = tempFiles[i];
                    if (size > maxSize) {
                        globalThis.queryResult(false, "图片过大");
                        break;
                    }
                    imageArr.push({ src: path });
                }
                if (imageArr.length > maxCount) {
                    globalThis.queryResult(false, "图片数量超过限制");
                    imageArr.length = maxCount;
                }
                this.setData({ imageArr });
                this.triggerEvent("onChildFn", {
                    fn: "onImageChange",
                    params: { imageArr, parent },
                });
            } catch (e) {
                console.log("没有选择图片", e);
            }
        },
        onPictureDeletion(e) {
            let { imageArr } = this.data;
            let { obj, index, parent } = e.currentTarget.dataset;
            imageArr.splice(index, 1);
            console.log("删除了图片", imageArr);
            this.setData({ imageArr, obj, index });
            this.triggerEvent("onChildFn", {
                fn: "onImageChange",
                params: { imageArr, obj, index, parent },
            });
        },
    },
});
