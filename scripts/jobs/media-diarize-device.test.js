import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('pyannote device selection handles CPU, unavailable MPS, and automatic fallback without models', () => {
  const python = `import ast, contextlib, io, os, pathlib, sys, types
source = pathlib.Path(sys.argv[1]).read_text()
function = next(node for node in ast.parse(source).body
                if isinstance(node, ast.FunctionDef) and node.name == "init_pyannote")
code = compile(ast.Module(body=[function], type_ignores=[]), sys.argv[1], "exec")

class ModelRoot:
    def __truediv__(self, _name):
        return self
    def is_file(self):
        return True
    def __str__(self):
        return "fake-model"

class Pipeline:
    loads = 0
    fail = False
    @classmethod
    def from_pretrained(cls, _path):
        cls.loads += 1
        return cls()
    def to(self, device):
        if device == "mps" and self.fail:
            raise RuntimeError("move failed\\nsecond line")

pyannote = types.ModuleType("pyannote")
audio = types.ModuleType("pyannote.audio")
audio.Pipeline = Pipeline
pyannote.audio = audio
sys.modules["pyannote"] = pyannote
sys.modules["pyannote.audio"] = audio
torch = types.ModuleType("torch")
torch.backends = types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: False))
torch.device = lambda name: name
sys.modules["torch"] = torch
namespace = {"PYANNOTE_MODEL": ModelRoot(), "os": os, "sys": sys}
exec(code, namespace)
initialize = namespace["init_pyannote"]

os.environ["MEDIA_DIARIZE_DEVICE"] = "cpu"
assert initialize(2)[1] == "cpu"
os.environ["MEDIA_DIARIZE_DEVICE"] = "mps"
try:
    initialize(2)
    raise AssertionError("forced MPS must fail when unavailable")
except RuntimeError as error:
    assert "unavailable" in str(error)

torch.backends.mps.is_available = lambda: True
os.environ["MEDIA_DIARIZE_DEVICE"] = "auto"
Pipeline.fail = True
before = Pipeline.loads
stderr = io.StringIO()
with contextlib.redirect_stderr(stderr):
    assert initialize(2)[1] == "cpu"
assert Pipeline.loads == before + 2
assert len(stderr.getvalue().splitlines()) == 1
assert "move failed second line" in stderr.getvalue()

Pipeline.fail = False
assert initialize(2)[1] == "mps"
os.environ["MEDIA_DIARIZE_DEVICE"] = "mps"
Pipeline.fail = True
try:
    initialize(2)
    raise AssertionError("forced MPS must fail on movement error")
except RuntimeError as error:
    assert "move failed" in str(error)
`;
  const script = fileURLToPath(new URL('../tools/diarize/media_diarize.py', import.meta.url));
  assert.equal(execFileSync('python3', ['-c', python, script], { encoding: 'utf8' }), '');
});
