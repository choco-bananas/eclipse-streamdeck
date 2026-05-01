import typescript from "@rollup/plugin-typescript";
import nodeResolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";

export default {
    input: "src/plugin.ts",
    output: {
        file: "com.mtcjapan.eclipsehci.sdPlugin/plugin.js",
        format: "cjs",
        sourcemap: true,
    },
    plugins: [
        nodeResolve({ preferBuiltins: true }),
        commonjs(),
        typescript({ tsconfig: "./tsconfig.json" }),
    ],
    external: [],
};
