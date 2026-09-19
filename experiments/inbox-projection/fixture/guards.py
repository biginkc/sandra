"""Pure bootstrap validation, deliberately independent of Python assert flags."""
CONTAINER_ID='603c10117cb7ef6a07d81448dd1a25b0c1ee2787a59f75871015c4a416cac557'
IMAGE_ID='sha256:28f0e16a019e648089fc1a6d333549a55548f6019c15ae4bd7cd58b989027518'
def validate_container(d):
    checks = [
        (d.get('Id') == CONTAINER_ID, 'container identity'),
        (d.get('Image') == IMAGE_ID, 'pinned image identity'),
        (d.get('Config', {}).get('Labels', {}).get('purpose') == 'sandra-inbox-projection-t2', 'ownership label'),
        (d.get('State', {}).get('Running') is True, 'running state'),
        (d.get('HostConfig', {}).get('NetworkMode') == 'none', 'network isolation'),
        (not d.get('HostConfig', {}).get('PortBindings'), 'unpublished ports'),
        (d.get('HostConfig', {}).get('Memory') == 536870912, '512 MiB memory limit'),
        (d.get('HostConfig', {}).get('NanoCpus') == 1000000000, 'one CPU limit'),
    ]
    for ok, description in checks:
        if not ok:
            raise RuntimeError('Refusing bootstrap: invalid '+description)
def validate_digest(actual, expected, label):
    if actual != expected:
        raise RuntimeError('Source digest mismatch: '+label)
def validate_cron(value):
    if value != 'off':
        raise RuntimeError('Refusing bootstrap: cron execution enabled or unknown')
