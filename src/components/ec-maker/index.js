const app = getApp();
const echarts = app.require("./miniprogram_npm/ec-canvas/echarts.js");

Component({
    properties: {
        configObj: {
            type: Object,
            observer: function (newValue, oldValue) {
                if (newValue && newValue.option) {
                    console.log("数据配置已就位，准备加载图表");
                    this.initChart();
                }
            },
        },
    },
    data: {
        ec: {
            lazyLoad: true,
        }, // 将 lazyLoad 设为 true 后，需要手动初始化图表
        isLoaded: false,
        isDisposed: false,
    },
    ready: function () {
        this.ecComponent = "";
    },
    methods: {
        dispose: function () {
            if (this.chart) {
                this.chart.dispose();
            }
            this.setData({
                isDisposed: true,
            });
            console.log("图表已销毁");
        },
        initChart: function () {
            let { configObj } = this.data;
            let { option, id } = configObj || {};
            if (!option) return console.log("选项未就位");
            if (!this.ecComponent) this.ecComponent = this.selectComponent("#echart");
            this.ecComponent.init((canvas, width, height) => {
                let chart = echarts.init(canvas, null, {
                    width,
                    height,
                });
                canvas.setChart(chart);
                chart.setOption(option);
                // 将图表实例绑定到 this 上，可以在其他成员函数（如 dispose）中访问
                this.chart = chart;
                this.setData({
                    isLoaded: true,
                    isDisposed: false,
                });
                console.log("已加载图表");
                return chart;
            });
        },
    },
});
