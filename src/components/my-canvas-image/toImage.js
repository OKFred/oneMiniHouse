/**
 * @author Fred
 * @desc 图片处理
 * @since 2023-06-09 20:56:00
 */

/**
 * @description: 保存图片到相册
 * @param {String} src 图片路径
 * @return {Boolean} 是否保存成功
 * @example: imageToAlbum(src)
 * @example: src = "https://example.com/abc.png"
 **/
async function imageToAlbum(src) {
    let res = await new Promise((resolve, reject) => {
        if (!uni.getSetting) return resolve({ authSetting: { "scope.writePhotosAlbum": true } });
        uni.getSetting({ success: resolve }); //获取用户的当前设置
    }); //验证用户是否授权可以访问相册
    if (!res.authSetting["scope.writePhotosAlbum"]) {
        return uni.authorize({
            scope: "scope.writePhotosAlbum",
            success: () => {
                uni.saveImageToPhotosAlbum();
            },
            fail: () => {
                uni.showToast({
                    title: "请打开保存相册权限再试",
                    icon: "none",
                    duration: 2000,
                });
                setTimeout(() => {
                    uni.openSetting({
                        //调起客户端小程序设置界面,让用户开启访问相册
                        success: (res2) => {
                            // console.log(res2.authSetting)
                        },
                    });
                }, 2000);
            },
        }); //如果没有授权，向用户发起请求
    }
    console.log(res);
    let filePath = await new Promise((resolve, reject) => {
        uni.getImageInfo({
            src,
            success: (res) => {
                resolve(res.path);
            },
            fail: (res) => {
                console.log(res);
                resolve(false);
            },
        });
    });
    if (!filePath) return uni.showToast({ title: "图片加载失败", icon: "none", duration: 2000 });
    let result = await new Promise((resolve, reject) =>
        uni.saveImageToPhotosAlbum({
            filePath,
            success: () => resolve(true),
            fail: (res) => {
                console.log(res);
                resolve(false);
            },
        }),
    );
    uni.hideLoading();
    // console.log(result)
    if (!result)
        return uni.showToast({
            title: "保存失败",
            icon: "none",
            duration: 2000,
        });
    uni.showToast({
        title: "保存成功，请从相册中查看",
        icon: "none",
        duration: 2000,
    });
} //保存图片到相册

export { imageToAlbum };
