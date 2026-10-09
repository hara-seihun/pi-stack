"""Promote pinned FP16 ONNX to FP32, then quantize MatMul weights for x86 CPU.

The numerical weights originate from the pinned FP16 export. FP32 promotion
removes costly CPU casts; dynamic INT8 MatMul quantization preserves the
preprocessor and non-MatMul FP32 operators.
"""
import hashlib
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import numpy_helper
from onnxruntime.quantization import QuantType, quantize_dynamic

QUANTIZED = ('98b23c60d6e5ad20b473c4fd83f21ad811f48b700b57c93b5baafc34b808fe7b', 'ba7314cb4acfd51a9c2f48fb25e9ab64857929097783fbc6830e9fb92543a3f1')

EXPECTED = {
    'encoder_model': ('d5bb0a328ce36320e9e1feadb62621e2a6dccdc08bf286b4a3f0a8ca74e8c3a0', 'aa9bdae43d13632739eafa3fa56124000846fe8f1db8dee131dce413e289663f'),
    'decoder_model': ('2903d88e31f84a38d8f8246f1ac7dd310c01f99ae8d74cb328e2aab4c498b774', '5d741dfff408269006146274b4829ebe04fe39ee6e0ccb319c00162ee923cd5b'),
}


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as data:
        for block in iter(lambda: data.read(4 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def convert(model_dir, name):
    source = model_dir / 'fp16' / (name + '.onnx')
    target = model_dir / 'fp32' / (name + '.onnx')
    data = model_dir / 'fp32' / (name + '.onnx.data')
    expected_graph, expected_data = EXPECTED[name]
    if target.is_file() and data.is_file() and digest(target) == expected_graph and digest(data) == expected_data:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    model = onnx.load(str(source), load_external_data=True)
    for tensor in model.graph.initializer:
        if tensor.data_type != onnx.TensorProto.FLOAT16:
            continue
        tensor.CopyFrom(numpy_helper.from_array(numpy_helper.to_array(tensor).astype(np.float32), name=tensor.name))
    for node in model.graph.node:
        for attr in node.attribute:
            if node.op_type == 'Cast' and attr.name == 'to' and attr.i == onnx.TensorProto.FLOAT16:
                attr.i = onnx.TensorProto.FLOAT
            if attr.type == onnx.AttributeProto.TENSOR and attr.t.data_type == onnx.TensorProto.FLOAT16:
                attr.t.CopyFrom(numpy_helper.from_array(numpy_helper.to_array(attr.t).astype(np.float32), name=attr.t.name))
    for value in list(model.graph.input) + list(model.graph.output) + list(model.graph.value_info):
        if value.type.tensor_type.elem_type == onnx.TensorProto.FLOAT16:
            value.type.tensor_type.elem_type = onnx.TensorProto.FLOAT
    data.unlink(missing_ok=True)
    target.unlink(missing_ok=True)
    onnx.save_model(model, str(target), save_as_external_data=True, all_tensors_to_one_file=True,
                    location=name + '.onnx.data', size_threshold=1024)
    if digest(target) != expected_graph or digest(data) != expected_data:
        target.unlink(missing_ok=True)
        data.unlink(missing_ok=True)
        raise RuntimeError(f'FP32 conversion mismatch: {name}')


def quantize(root):
    source = root / 'fp32/encoder_model.onnx'
    target = root / 'int8/encoder_model.onnx'
    data = root / 'int8/encoder_model.onnx.data'
    if not (target.is_file() and data.is_file() and (digest(target), digest(data)) == QUANTIZED):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.unlink(missing_ok=True)
        data.unlink(missing_ok=True)
        quantize_dynamic(str(source), str(target), weight_type=QuantType.QInt8,
                         per_channel=False, op_types_to_quantize=['MatMul'], use_external_data_format=True)
        if (digest(target), digest(data)) != QUANTIZED:
            target.unlink(missing_ok=True)
            data.unlink(missing_ok=True)
            raise RuntimeError('INT8 encoder quantization mismatch')
    source.unlink(missing_ok=True)
    (root / 'fp32/encoder_model.onnx.data').unlink(missing_ok=True)


if __name__ == '__main__':
    root = Path(sys.argv[1])
    convert(root, 'decoder_model')
    encoder = root / 'fp32/encoder_model.onnx'
    if not ((root / 'int8/encoder_model.onnx').is_file() and (root / 'int8/encoder_model.onnx.data').is_file() and
            (digest(root / 'int8/encoder_model.onnx'), digest(root / 'int8/encoder_model.onnx.data')) == QUANTIZED):
        convert(root, 'encoder_model')
    quantize(root)
